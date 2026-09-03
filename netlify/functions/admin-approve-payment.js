/*
 * POST /api/admin-approve-payment
 *
 * Both Owner and Admin may approve — this is core day-to-day order review,
 * not a Team/permanent-delete-tier action (requireAdmin(), not
 * requireOwner()). The ONLY way an order's paymentStatus can become
 * "paid". Only succeeds from pending_review — approving from any other
 * state is refused outright, not silently no-op'd.
 *
 * Marks the LATEST payment attempt as "approved" (with reviewedBy/
 * reviewedAt) rather than appending a new one — approval reviews an
 * existing submission, it doesn't create a new payment attempt.
 *
 * Phase 5D: this is the ONLY place inventory is ever permanently committed
 * (stockQty actually decremented). Requires the reservation to be `locked`
 * — _shared/inventory.js's consumeReservation() itself re-checks this and
 * throws ReservationConflictError('ALREADY_PROCESSED') if it isn't, so a
 * retried/double-clicked approval can never deduct twice: the FIRST
 * successful call already moved paymentStatus off pending_review (caught
 * above) AND moved the reservation off locked (caught here) — either guard
 * alone would already stop a retry, and both apply. Legacy isTest orders
 * have no reservation document and skip this entirely.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { requireString } = require('./_shared/validation');
const { consumeReservation, ReservationConflictError } = require('./_shared/inventory');
const { getEmailSettings } = require('./_shared/emailSettings');
const { enqueuePaymentApproved } = require('./_shared/emailOutbox');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');
  const orderId = requireString(body.orderId, 'orderId', { maxLength: 100 });

  const db = getDb();
  const ref = db.collection('orders').doc(orderId);

  let result;
  try {
    result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: 'Order not found.' };

    const order = snap.data();
    if (order.paymentStatus !== 'pending_review') {
      return { ok: false, status: 400, error: `Cannot approve — order is currently "${order.paymentStatus}", not pending_review.` };
    }

    const attempts = order.paymentAttempts || [];
    const lastIndex = attempts.length - 1;
    if (lastIndex < 0) return { ok: false, status: 400, error: 'This order has no payment attempt to approve.' };

    // Read BEFORE any write in this transaction (Firestore's reads-before-
    // writes rule) — consumeReservation() below writes.
    const emailSettings = await getEmailSettings(db, tx);

    const now = admin.firestore.Timestamp.now();
    const updatedAttempts = attempts.map((a, i) => (i === lastIndex ? { ...a, status: 'approved', reviewedBy: auth.uid, reviewedAt: now } : a));

    const paymentHistoryEntry = {
      action: 'payment_approved',
      at: now,
      actorType: 'admin',
      actorId: auth.uid,
      meta: { previousStatus: 'pending_review', newStatus: 'paid' },
    };

    let consumePatch = null;
    if (order.isTest !== true) {
      const reservationRef = db.collection('inventoryReservations').doc(orderId);
      consumePatch = (await consumeReservation(tx, db, reservationRef, { actorType: 'admin', actorId: auth.uid })).orderPatch;
    }

    tx.update(ref, {
      paymentAttempts: updatedAttempts,
      paymentStatus: 'paid',
      ...(consumePatch ? { inventoryStatus: consumePatch.inventoryStatus } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      history: consumePatch
        ? admin.firestore.FieldValue.arrayUnion(paymentHistoryEntry, consumePatch.historyEntry)
        : admin.firestore.FieldValue.arrayUnion(paymentHistoryEntry),
    });

    enqueuePaymentApproved(tx, db, {
      orderId,
      attemptId: attempts[lastIndex].attemptId,
      recipientEmail: order.customerEmail,
      payload: { orderNumber: order.orderNumber, customerName: order.customerName, total: order.pricing.total },
      isTestOrder: order.isTest === true,
      emailSettings,
      now,
    });

      return { ok: true };
    });
  } catch (err) {
    if (err instanceof ReservationConflictError) {
      return fail(409, 'This order\'s inventory reservation is not in a locked state — it may have already been approved. Refresh and check the order status.');
    }
    throw err;
  }

  if (!result.ok) return fail(result.status, result.error);
  return ok({ paymentStatus: 'paid' });
});
