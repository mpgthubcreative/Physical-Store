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
 *
 * Phase 5D.2 — courier + tracking:
 * Moving a DELIVERY order to "shipped" requires a courier name; a tracking
 * number is optional, because some local/provincial couriers don't issue
 * one. Both are written once, on that transition only, and are never
 * cleared by a later transition (completing an order does not erase how it
 * shipped). A pickup order can still never reach "shipped" at all, so it
 * can never carry courier/tracking.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { requireString, optionalString, requireOneOf } = require('./_shared/validation');
const { getEmailSettings } = require('./_shared/emailSettings');
const { enqueueFulfillmentEvent } = require('./_shared/emailOutbox');

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

  // Courier is mandatory when shipping, tracking number is not. Validated
  // up front so a bad value fails before the transaction opens; the
  // delivery-method guard inside the transaction still independently
  // refuses "shipped" for a pickup order.
  let courier = null;
  let trackingNumber = null;
  if (targetStatus === 'shipped') {
    courier = requireString(body.courier, 'Courier', { maxLength: 80 });
    trackingNumber = optionalString(body.trackingNumber, 'Tracking number', { maxLength: 100 }) || null;
  }

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

    // Read BEFORE any write in this transaction (Firestore's reads-before-
    // writes rule).
    const emailSettings = await getEmailSettings(db, tx);

    const now = admin.firestore.Timestamp.now();

    // Only the shipped transition writes courier/tracking. Every other
    // transition omits these keys entirely, so completing a shipped order
    // leaves its courier and tracking number exactly as recorded.
    const shippingPatch = targetStatus === 'shipped' ? { courier, trackingNumber } : {};

    tx.update(ref, {
      fulfillmentStatus: targetStatus,
      ...shippingPatch,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      history: admin.firestore.FieldValue.arrayUnion({
        action: 'fulfillment_updated',
        at: now,
        actorType: 'admin',
        actorId: auth.uid,
        meta: {
          previousStatus: current,
          newStatus: targetStatus,
          ...(targetStatus === 'shipped' ? { courier, trackingNumber } : {}),
        },
      }),
    });

    enqueueFulfillmentEvent(tx, db, {
      status: targetStatus,
      orderId,
      recipientEmail: order.customerEmail,
      payload: { orderNumber: order.orderNumber, customerName: order.customerName, courier, trackingNumber },
      isTestOrder: order.isTest === true,
      emailSettings,
      now,
    });

    return { ok: true };
  });

  if (!result.ok) return fail(result.status, result.error);
  return ok({ fulfillmentStatus: targetStatus, courier, trackingNumber });
});
