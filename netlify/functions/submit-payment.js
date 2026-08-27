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
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { requireString } = require('./_shared/validation');
const { isValidAccessToken, isValidIdempotencyKey, hashToken, hashesMatch } = require('./_shared/orderSecurity');
const { getPaymentSettings, sanitizePaymentMethodsForCustomer } = require('./_shared/settings');

const RESUBMIT_ALLOWED_FROM = ['awaiting_payment', 'rejected'];

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const body = JSON.parse(event.body || '{}');
  const db = getDb();

  const token = requireString(body.token, 'token', { maxLength: 100 });
  if (!isValidAccessToken(token)) return fail(404, 'Order not found.');

  const attemptId = requireString(body.attemptId, 'attemptId', { maxLength: 100 });
  if (!isValidIdempotencyKey(attemptId)) return fail(400, 'Invalid attempt ID.');

  const paymentMethod = requireString(body.paymentMethod, 'paymentMethod', { maxLength: 60 });
  const paymentReference = requireString(body.paymentReference, 'Payment reference', { maxLength: 100 });
  const payerName = requireString(body.payerName, 'Payer name', { maxLength: 100 });

  const paymentSettings = await getPaymentSettings(db);
  const enabledIds = sanitizePaymentMethodsForCustomer(paymentSettings).map((m) => m.id);
  if (!enabledIds.includes(paymentMethod)) return fail(400, 'Please select a valid payment method.');

  const hash = hashToken(token);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(db.collection('orders').where('accessTokenHash', '==', hash).limit(1));
    if (snap.empty) return { ok: false, status: 404, error: 'Order not found.' };

    const doc = snap.docs[0];
    const order = doc.data();
    if (!hashesMatch(hash, order.accessTokenHash)) return { ok: false, status: 404, error: 'Order not found.' };

    const attempts = order.paymentAttempts || [];
    const existing = attempts.find((a) => a.attemptId === attemptId);
    if (existing) {
      return { ok: true, alreadyProcessed: true, paymentStatus: order.paymentStatus };
    }

    if (!RESUBMIT_ALLOWED_FROM.includes(order.paymentStatus)) {
      return { ok: false, status: 400, error: `Cannot submit payment — order is currently "${order.paymentStatus}".` };
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

    tx.update(doc.ref, {
      paymentAttempts: admin.firestore.FieldValue.arrayUnion(newAttempt),
      paymentStatus: 'pending_review',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      history: admin.firestore.FieldValue.arrayUnion({
        action: 'payment_submitted',
        at: now,
        actorType: 'customer',
        actorId: null,
        meta: { previousStatus: order.paymentStatus, newStatus: 'pending_review' },
      }),
    });

    return { ok: true, alreadyProcessed: false, paymentStatus: 'pending_review' };
  });

  if (!result.ok) return fail(result.status, result.error);
  return ok({ paymentStatus: result.paymentStatus, alreadyProcessed: result.alreadyProcessed });
});
