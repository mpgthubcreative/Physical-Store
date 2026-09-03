/*
 * POST /api/submit-payment
 *
 * PUBLIC — token-authenticated the same way get-order.js is. This function
 * can NEVER set paymentStatus to "paid" or touch price/items — the only
 * transition it makes is awaiting_payment|rejected -> pending_review, and
 * only that.
 *
 * Every submission is appended to `paymentAttempts[]` — a rejected attempt
 * is never overwritten, so the full history of payment tries stays visible
 * on the order forever (Phase 5C correction #14).
 *
 * Idempotency: the browser sends a client-generated `attemptId` with every
 * submission. If an attempt with that exact ID already exists on the
 * order, this returns the existing result instead of appending a second
 * entry — handles a double-click or network retry of the SAME submission
 * without the status-transition guard alone (which only protects against a
 * second, genuinely different submission arriving while one is already
 * pending_review).
 *
 * Phase 5D: before accepting a submission, the order's reservation must
 * still be `active` and unexpired. If its TTL already passed, it's
 * lazily expired right here (inventory released, order.inventoryStatus set
 * to `expired`) and the submission is rejected — the customer must
 * re-reserve (POST /api/reserve-order) before they're shown usable payment
 * controls again. On success the reservation is locked (active -> locked),
 * which also clears its automatic expiration: once a customer may actually
 * have transferred money, inventory must not silently return to stock
 * merely because Admin review is delayed. Legacy isTest orders (created
 * before Phase 5D) have no reservation document at all and bypass every
 * bit of this — never a general-purpose bypass, only for that explicitly
 * pre-existing, server-marked legacy data.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail, json } = require('./_shared/response');
const { requireString } = require('./_shared/validation');
const { isValidIdempotencyKey } = require('./_shared/orderSecurity');
const { resolveOrderByToken, TOKEN_FIELD_MAX_LENGTH } = require('./_shared/orderTokenAuth');
const { getPaymentSettings, sanitizePaymentMethodsForCustomer } = require('./_shared/settings');
const { expireReservationIfDue, lockReservation } = require('./_shared/inventory');
const { getEmailSettings } = require('./_shared/emailSettings');
const { enqueuePaymentSubmitted, enqueueAdminPaymentReview, enqueueReservationExpired } = require('./_shared/emailOutbox');

const RESUBMIT_ALLOWED_FROM = ['awaiting_payment', 'rejected'];

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const body = JSON.parse(event.body || '{}');
  const db = getDb();

  const token = requireString(body.token, 'token', { maxLength: TOKEN_FIELD_MAX_LENGTH });

  const attemptId = requireString(body.attemptId, 'attemptId', { maxLength: 100 });
  if (!isValidIdempotencyKey(attemptId)) return fail(400, 'Invalid attempt ID.');

  const paymentMethod = requireString(body.paymentMethod, 'paymentMethod', { maxLength: 60 });
  const paymentReference = requireString(body.paymentReference, 'Payment reference', { maxLength: 100 });
  const payerName = requireString(body.payerName, 'Payer name', { maxLength: 100 });

  const paymentSettings = await getPaymentSettings(db);
  const enabledIds = sanitizePaymentMethodsForCustomer(paymentSettings).map((m) => m.id);
  if (!enabledIds.includes(paymentMethod)) return fail(400, 'Please select a valid payment method.');

  const result = await db.runTransaction(async (tx) => {
    const resolved = await resolveOrderByToken(db, token, 'payment:submit', { tx });
    if (!resolved.ok) return { ok: false, status: 404, error: 'Order not found.' };
    const { doc, order } = resolved;

    // Read BEFORE any write in this transaction (Firestore's reads-before-
    // writes rule) — enqueueEmail() below needs it and must never re-read
    // mutable config later, only use what was true at enqueue time.
    const emailSettings = await getEmailSettings(db, tx);

    const attempts = order.paymentAttempts || [];
    const existing = attempts.find((a) => a.attemptId === attemptId);
    if (existing) {
      return { ok: true, alreadyProcessed: true, paymentStatus: order.paymentStatus };
    }

    if (!RESUBMIT_ALLOWED_FROM.includes(order.paymentStatus)) {
      return { ok: false, status: 400, error: `Cannot submit payment — order is currently "${order.paymentStatus}".` };
    }

    let lockPatch = null;
    if (order.isTest !== true) {
      const reservationRef = db.collection('inventoryReservations').doc(doc.id);
      const { reservation, expiredNow, orderPatch } = await expireReservationIfDue(tx, db, reservationRef, { actorType: 'customer' });
      if (expiredNow || reservation.status !== 'active') {
        if (expiredNow) {
          const expiryNow = admin.firestore.Timestamp.now();
          tx.update(doc.ref, {
            inventoryStatus: orderPatch.inventoryStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            history: admin.firestore.FieldValue.arrayUnion(orderPatch.historyEntry),
          });
          enqueueReservationExpired(tx, db, {
            orderId: doc.id,
            reservationExpiresAtMs: reservation.expiresAt.toMillis(),
            recipientEmail: order.customerEmail,
            payload: { orderNumber: order.orderNumber, customerName: order.customerName },
            isTestOrder: order.isTest === true,
            emailSettings,
            now: expiryNow,
          });
        }
        return {
          ok: false,
          status: 409,
          error: 'Your reservation for this order has expired. Please try to reserve again before submitting payment.',
          reservationExpired: true,
        };
      }
      lockPatch = lockReservation(tx, reservationRef, { actorType: 'customer' }).orderPatch;
    }

    const now = admin.firestore.Timestamp.now();
    const newAttempt = {
      attemptId,
      paymentMethod,
      paymentReference,
      payerName,
      submittedAt: now,
      status: 'pending_review',
      reviewedBy: null,
      reviewedAt: null,
      rejectionCode: null,
      rejectionNote: null,
    };

    const paymentHistoryEntry = {
      action: 'payment_submitted',
      at: now,
      actorType: 'customer',
      actorId: null,
      meta: { previousStatus: order.paymentStatus, newStatus: 'pending_review' },
    };

    tx.update(doc.ref, {
      paymentAttempts: admin.firestore.FieldValue.arrayUnion(newAttempt),
      paymentStatus: 'pending_review',
      ...(lockPatch ? { inventoryStatus: lockPatch.inventoryStatus } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      history: lockPatch
        ? admin.firestore.FieldValue.arrayUnion(paymentHistoryEntry, lockPatch.historyEntry)
        : admin.firestore.FieldValue.arrayUnion(paymentHistoryEntry),
    });

    const isTestOrder = order.isTest === true;
    enqueuePaymentSubmitted(tx, db, {
      orderId: doc.id,
      attemptId,
      recipientEmail: order.customerEmail,
      payload: { orderNumber: order.orderNumber, customerName: order.customerName, paymentMethod, paymentReference, total: order.pricing.total },
      isTestOrder,
      emailSettings,
      now,
    });
    const adminEmail = (process.env.ADMIN_NOTIFICATION_EMAIL || '').trim();
    if (adminEmail) {
      enqueueAdminPaymentReview(tx, db, {
        orderId: doc.id,
        attemptId,
        adminEmail,
        payload: { orderNumber: order.orderNumber, customerName: order.customerName, paymentMethod, paymentReference, total: order.pricing.total },
        isTestOrder,
        emailSettings,
        now,
      });
    }

    return { ok: true, alreadyProcessed: false, paymentStatus: 'pending_review' };
  });

  if (!result.ok) {
    if (result.reservationExpired) return json(result.status, { error: result.error, reservationExpired: true });
    return fail(result.status, result.error);
  }
  return ok({ paymentStatus: result.paymentStatus, alreadyProcessed: result.alreadyProcessed });
});
