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
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireString, optionalString, requireOneOf } = require('./_shared/validation');

const REJECTION_CODES = ['REFERENCE_NOT_FOUND', 'AMOUNT_MISMATCH', 'DUPLICATE_REFERENCE', 'WRONG_PAYMENT_METHOD', 'OTHER'];

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

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: 'Order not found.' };

    const order = snap.data();
    if (order.paymentStatus !== 'pending_review') {
      return { ok: false, status: 400, error: `Cannot reject — order is currently "${order.paymentStatus}", not pending_review.` };
    }

    const attempts = order.paymentAttempts || [];
    const lastIndex = attempts.length - 1;
    if (lastIndex < 0) return { ok: false, status: 400, error: 'This order has no payment attempt to reject.' };

    const now = admin.firestore.Timestamp.now();
    const updatedAttempts = attempts.map((a, i) =>
      i === lastIndex ? { ...a, status: 'rejected', reviewedBy: auth.uid, reviewedAt: now, rejectionCode, rejectionNote: rejectionNote || null } : a
    );

    tx.update(ref, {
      paymentAttempts: updatedAttempts,
      paymentStatus: 'rejected',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      history: admin.firestore.FieldValue.arrayUnion({
        action: 'payment_rejected',
        at: now,
        actorType: 'admin',
        actorId: auth.uid,
        meta: { previousStatus: 'pending_review', newStatus: 'rejected', rejectionCode, rejectionNote: rejectionNote || null },
      }),
    });

    return { ok: true };
  });

  if (!result.ok) return fail(result.status, result.error);
  return ok({ paymentStatus: 'rejected' });
});
