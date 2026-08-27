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
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { requireString } = require('./_shared/validation');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');
  const orderId = requireString(body.orderId, 'orderId', { maxLength: 100 });

  const db = getDb();
  const ref = db.collection('orders').doc(orderId);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: 'Order not found.' };

    const order = snap.data();
    if (order.paymentStatus !== 'pending_review') {
      return { ok: false, status: 400, error: `Cannot approve — order is currently "${order.paymentStatus}", not pending_review.` };
    }

    const attempts = order.paymentAttempts || [];
    const lastIndex = attempts.length - 1;
    if (lastIndex < 0) return { ok: false, status: 400, error: 'This order has no payment attempt to approve.' };

    const now = admin.firestore.Timestamp.now();
    const updatedAttempts = attempts.map((a, i) => (i === lastIndex ? { ...a, status: 'approved', reviewedBy: auth.uid, reviewedAt: now } : a));

    tx.update(ref, {
      paymentAttempts: updatedAttempts,
      paymentStatus: 'paid',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      history: admin.firestore.FieldValue.arrayUnion({
        action: 'payment_approved',
        at: now,
        actorType: 'admin',
        actorId: auth.uid,
        meta: { previousStatus: 'pending_review', newStatus: 'paid' },
      }),
    });

    return { ok: true };
  });

  if (!result.ok) return fail(result.status, result.error);
  return ok({ paymentStatus: 'paid' });
});
