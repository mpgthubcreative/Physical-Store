/*
 * POST /api/admin-update-fulfillment
 *
 * Both Owner and Admin. One shared endpoint for every fulfillment
 * transition rather than a micro-function per status — the valid
 * transition table lives here, server-side, never trusted from the
 * client beyond which target state was requested.
 *
 * A fulfillment order must stay "unfulfilled" until paymentStatus is
 * "paid" — this function refuses to move it out of unfulfilled otherwise.
 * ready_for_pickup is only valid for deliveryMethod:"pickup" orders;
 * shipped only for "delivery" orders. Cancellation is NOT part of this
 * status model yet (Phase 5C scope) — that's designed separately once a
 * cancellation/refund workflow exists.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { requireString, requireOneOf } = require('./_shared/validation');

const ALL_STATUSES = ['unfulfilled', 'processing', 'ready_for_pickup', 'shipped', 'completed'];

const VALID_FROM = {
  unfulfilled: ['processing'],
  processing: ['ready_for_pickup', 'shipped'],
  ready_for_pickup: ['completed'],
  shipped: ['completed'],
  completed: [],
};

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');
  const orderId = requireString(body.orderId, 'orderId', { maxLength: 100 });
  const targetStatus = requireOneOf(body.fulfillmentStatus, 'fulfillmentStatus', ALL_STATUSES);

  const db = getDb();
  const ref = db.collection('orders').doc(orderId);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: 'Order not found.' };

    const order = snap.data();
    const current = order.fulfillmentStatus;

    if (current === 'unfulfilled' && order.paymentStatus !== 'paid') {
      return { ok: false, status: 400, error: 'Fulfillment cannot begin until payment is approved.' };
    }

    const allowed = VALID_FROM[current] || [];
    if (!allowed.includes(targetStatus)) {
      return { ok: false, status: 400, error: `Cannot move from "${current}" to "${targetStatus}".` };
    }

    if (targetStatus === 'ready_for_pickup' && order.deliveryMethod !== 'pickup') {
      return { ok: false, status: 400, error: '"ready_for_pickup" only applies to pickup orders.' };
    }
    if (targetStatus === 'shipped' && order.deliveryMethod !== 'delivery') {
      return { ok: false, status: 400, error: '"shipped" only applies to delivery orders.' };
    }

    const now = admin.firestore.Timestamp.now();
    tx.update(ref, {
      fulfillmentStatus: targetStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      history: admin.firestore.FieldValue.arrayUnion({
        action: 'fulfillment_updated',
        at: now,
        actorType: 'admin',
        actorId: auth.uid,
        meta: { previousStatus: current, newStatus: targetStatus },
      }),
    });

    return { ok: true };
  });

  if (!result.ok) return fail(result.status, result.error);
  return ok({ fulfillmentStatus: targetStatus });
});
