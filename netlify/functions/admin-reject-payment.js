/*
 * POST /api/admin-reject-payment
 *
 * Both Owner and Admin may reject (requireAdmin(), same reasoning as
 * approve). Only succeeds from pending_review. Requires a fixed
 * machine-readable rejectionCode plus an optional note — a note is
 * required when the code is "OTHER".
 *
 * Marks the LATEST payment attempt as "rejected" (never overwrites it —
 * the attempt stays visible forever); a customer resubmission afterward
 * appends a brand-new attempt rather than reusing this one.
 *
 * Phase 5D: reactivates the reservation (locked -> active) with a fresh
 * 20-minute TTL rather than releasing it — the customer keeps their spot
 * to correct a bad reference/payment submission. reservedQty is NOT
 * decremented here (the reservation is still held, just no longer locked
 * to a specific pending review). Legacy isTest orders have no reservation
 * document and skip this entirely.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireString, optionalString, requireOneOf } = require('./_shared/validation');
const { reactivateReservation, ReservationConflictError } = require('./_shared/inventory');
const { getEmailSettings } = require('./_shared/emailSettings');
const { enqueuePaymentRejected } = require('./_shared/emailOutbox');

const REJECTION_CODES = ['REFERENCE_NOT_FOUND', 'AMOUNT_MISMATCH', 'DUPLICATE_REFERENCE', 'WRONG_PAYMENT_METHOD', 'OTHER'];

// Matches js/order.js's own REJECTION_LABELS exactly — the email should
// never say something different from what the order-status page says.
const REJECTION_LABELS = {
  REFERENCE_NOT_FOUND: 'We could not find this payment reference.',
  AMOUNT_MISMATCH: 'The amount paid did not match the order total.',
  DUPLICATE_REFERENCE: 'This payment reference has already been used.',
  WRONG_PAYMENT_METHOD: 'This payment method does not match what was selected.',
  OTHER: 'There was an issue with this payment.',
};

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');
  const orderId = requireString(body.orderId, 'orderId', { maxLength: 100 });
  const rejectionCode = requireOneOf(body.rejectionCode, 'rejectionCode', REJECTION_CODES);
  const rejectionNote = optionalString(body.rejectionNote, 'Admin note', { maxLength: 500 });

  if (rejectionCode === 'OTHER' && !rejectionNote) {
    throw new ValidationError('A note is required when selecting "Other".');
  }

  const db = getDb();
  const ref = db.collection('orders').doc(orderId);

  let result;
  try {
    result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: 'Order not found.' };

    const order = snap.data();
    if (order.paymentStatus !== 'pending_review') {
      return { ok: false, status: 400, error: `Cannot reject — order is currently "${order.paymentStatus}", not pending_review.` };
    }

    const attempts = order.paymentAttempts || [];
    const lastIndex = attempts.length - 1;
    if (lastIndex < 0) return { ok: false, status: 400, error: 'This order has no payment attempt to reject.' };

    // Read BEFORE any write in this transaction (Firestore's reads-before-
    // writes rule) — reactivateReservation() below writes.
    const emailSettings = await getEmailSettings(db, tx);

    const now = admin.firestore.Timestamp.now();
    const updatedAttempts = attempts.map((a, i) =>
      i === lastIndex ? { ...a, status: 'rejected', reviewedBy: auth.uid, reviewedAt: now, rejectionCode, rejectionNote: rejectionNote || null } : a
    );

    const paymentHistoryEntry = {
      action: 'payment_rejected',
      at: now,
      actorType: 'admin',
      actorId: auth.uid,
      meta: { previousStatus: 'pending_review', newStatus: 'rejected', rejectionCode, rejectionNote: rejectionNote || null },
    };

    let reactivatePatch = null;
    if (order.isTest !== true) {
      const reservationRef = db.collection('inventoryReservations').doc(orderId);
      reactivatePatch = (await reactivateReservation(tx, db, reservationRef, { actorType: 'admin', actorId: auth.uid })).orderPatch;
    }

    tx.update(ref, {
      paymentAttempts: updatedAttempts,
      paymentStatus: 'rejected',
      ...(reactivatePatch ? { inventoryStatus: reactivatePatch.inventoryStatus } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      history: reactivatePatch
        ? admin.firestore.FieldValue.arrayUnion(paymentHistoryEntry, reactivatePatch.historyEntry)
        : admin.firestore.FieldValue.arrayUnion(paymentHistoryEntry),
    });

    enqueuePaymentRejected(tx, db, {
      orderId,
      attemptId: attempts[lastIndex].attemptId,
      recipientEmail: order.customerEmail,
      payload: {
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        reasonLabel: REJECTION_LABELS[rejectionCode] || rejectionCode,
        reasonNote: rejectionNote || null,
        total: order.pricing.total,
      },
      isTestOrder: order.isTest === true,
      emailSettings,
      now,
    });

      return { ok: true };
    });
  } catch (err) {
    if (err instanceof ReservationConflictError) {
      return fail(409, 'This order\'s inventory reservation is not in a locked state — it may already have been reviewed. Refresh and check the order status.');
    }
    throw err;
  }

  if (!result.ok) return fail(result.status, result.error);
  return ok({ paymentStatus: 'rejected' });
});
