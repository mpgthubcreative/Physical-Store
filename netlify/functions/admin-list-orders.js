/*
 * GET /api/admin-list-orders?limit=&cursor=&paymentStatus=&fulfillmentStatus=
 *
 * Admin-only. Cursor-based pagination, newest first — this deliberately
 * never loads the whole `orders` collection. The cursor encodes the last
 * row's (createdAt, doc id) so ties at the same millisecond still page
 * correctly. Never returns accessTokenHash or any raw customer token.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const VALID_PAYMENT_STATUSES = ['awaiting_payment', 'pending_review', 'paid', 'rejected'];
const VALID_FULFILLMENT_STATUSES = ['unfulfilled', 'processing', 'ready_for_pickup', 'shipped', 'completed'];

function encodeCursor(doc) {
  const ms = doc.get('createdAt') ? doc.get('createdAt').toMillis() : 0;
  return Buffer.from(`${ms}:${doc.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [msStr, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    const ms = Number(msStr);
    if (!Number.isFinite(ms) || !id) return null;
    return { ms, id };
  } catch (err) {
    return null;
  }
}

function sanitizeOrderSummary(doc) {
  const order = doc.data();
  return {
    orderId: doc.id,
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    total: order.pricing ? order.pricing.total : null,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    inventoryStatus: order.inventoryStatus || null,
    deliveryMethod: order.deliveryMethod,
    isTest: order.isTest === true,
    createdAt: order.createdAt || null,
  };
}

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const params = event.queryStringParameters || {};
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.limit) || DEFAULT_LIMIT));

  const db = getDb();
  let query = db.collection('orders');

  if (params.paymentStatus && VALID_PAYMENT_STATUSES.includes(params.paymentStatus)) {
    query = query.where('paymentStatus', '==', params.paymentStatus);
  }
  if (params.fulfillmentStatus && VALID_FULFILLMENT_STATUSES.includes(params.fulfillmentStatus)) {
    query = query.where('fulfillmentStatus', '==', params.fulfillmentStatus);
  }

  query = query.orderBy('createdAt', 'desc').orderBy(admin.firestore.FieldPath.documentId(), 'desc');

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    if (decoded) {
      query = query.startAfter(admin.firestore.Timestamp.fromMillis(decoded.ms), decoded.id);
    }
  }

  const snap = await query.limit(limit).get();
  const orders = snap.docs.map(sanitizeOrderSummary);
  const nextCursor = snap.docs.length === limit ? encodeCursor(snap.docs[snap.docs.length - 1]) : null;

  return ok({ orders, nextCursor });
});
