/*
 * The single source of truth for reporting data.
 *
 * admin-report.js (dashboard JSON), the Excel export, and the PDF export
 * ALL go through the two functions here. That is deliberate: the brief
 * requires that an export never show a different dataset from the dashboard
 * it was triggered from, and the only durable way to guarantee that is to
 * have one query and one aggregator rather than three that happen to agree
 * today.
 *
 * ---- READ-ONLY ----
 * Nothing in this module writes. Reporting reads existing order snapshots
 * and statuses; it never alters payment, inventory, reservation, or
 * fulfillment state, and never recalculates a historical order's pricing.
 *
 * ---- Why isTest is filtered in memory, not in the Firestore query ----
 * `where('isTest','==',false)` looks like the obvious approach and is
 * WRONG here for two reasons:
 *   1. Firestore does not match documents where the field is ABSENT. Orders
 *      created before isTest existed have no such field, so that filter
 *      would silently drop real historical orders from every report —
 *      understating revenue with no error anywhere.
 *   2. It would force a new composite index (isTest ASC + createdAt DESC).
 * Filtering in memory after a createdAt range query is correct for missing
 * fields (absent is treated as "not a test order", which is what it means)
 * and needs no new index. The range query already bounds how much is read.
 *
 * ---- Financial rules (stated once, here) ----
 * ONLY paymentStatus === 'paid' counts toward sales. awaiting_payment,
 * pending_review and rejected contribute to ORDER COUNTS but never to
 * revenue. Every money figure comes from the order's own frozen
 * pricing snapshot:
 *     merchandise sales = pricing.subtotal
 *     shipping collected = pricing.shippingFee
 *     gross paid sales   = pricing.total
 * Current catalog prices and current shipping settings are never consulted.
 */
const { manilaDateTime } = require('./reportRange');

// A hard ceiling so one enormous range can never exhaust function memory.
// Reports say so explicitly when they hit it rather than silently truncating.
const MAX_REPORT_ORDERS = 5000;

const PAYMENT_STATUSES = ['awaiting_payment', 'pending_review', 'paid', 'rejected'];
const FULFILLMENT_STATUSES = ['unfulfilled', 'processing', 'ready_for_pickup', 'shipped', 'completed'];

const REGION_LABELS = { luzon: 'Luzon', visayas: 'Visayas', mindanao: 'Mindanao' };

function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds != null) return ts._seconds * 1000;
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Which payment method to report for an order.
 *
 * There is no top-level paymentMethod on the order document — the method
 * lives on each entry of paymentAttempts[]. The APPROVED attempt is the
 * truthful answer for a paid order; otherwise the most recent attempt is
 * what the customer last claimed. An order with no attempt yet reports null,
 * which every renderer shows as blank / "Not recorded".
 */
function derivePaymentMethod(order) {
  const attempts = Array.isArray(order.paymentAttempts) ? order.paymentAttempts : [];
  if (!attempts.length) return null;
  const approved = attempts.find((a) => a && a.status === 'approved');
  const chosen = approved || attempts[attempts.length - 1];
  return (chosen && chosen.paymentMethod) || null;
}

/** Human-readable destination, matching the Admin Orders table exactly. */
function destinationLabel(order) {
  if (order.deliveryMethod === 'pickup') return 'Pickup';
  const region = order.destinationRegion;
  if (!region) return 'Not recorded';
  return REGION_LABELS[region] || region;
}

/**
 * The reporting projection of an order.
 *
 * Deliberately a strict allowlist. accessTokenHash, idempotencyKey, the
 * customization snapshot, history, and the referenced* arrays are NEVER
 * included — a report must not become a way to exfiltrate order-access
 * tokens or internal auth material.
 */
function projectOrder(doc) {
  const o = doc.data();
  const pricing = o.pricing || {};
  const createdAtMs = toMillis(o.createdAt);

  return {
    orderId: doc.id,
    orderNumber: o.orderNumber || '',
    createdAtMs,
    // Pre-rendered in Manila time so every consumer (dashboard, Excel, PDF)
    // shows the same string and none of them re-derive the timezone.
    orderDate: createdAtMs ? manilaDateTime(createdAtMs) : '',
    customerName: o.customerName || '',
    customerEmail: o.customerEmail || '',
    customerMobile: o.customerMobile || '',
    deliveryMethod: o.deliveryMethod || '',
    // null on pickup orders and on every order predating Phase 5D.2.
    destinationRegion: o.destinationRegion || null,
    destination: destinationLabel(o),
    subtotal: num(pricing.subtotal),
    shippingFee: num(pricing.shippingFee),
    total: num(pricing.total),
    paymentMethod: derivePaymentMethod(o),
    paymentStatus: o.paymentStatus || '',
    fulfillmentStatus: o.fulfillmentStatus || '',
    // Absent on orders that shipped before Phase 5D.2.
    courier: o.courier || null,
    trackingNumber: o.trackingNumber || null,
    isTest: o.isTest === true,
  };
}

/**
 * Reads every order created within [startUtcMs, endUtcMs) and returns the
 * reporting projection, newest first.
 *
 * Uses a single-field range + orderBy on createdAt, which Firestore serves
 * from its automatic single-field index — NO composite index is required.
 */
async function fetchReportOrders(db, { startUtcMs, endUtcMs, includeTest }, admin) {
  const snap = await db
    .collection('orders')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromMillis(startUtcMs))
    .where('createdAt', '<', admin.firestore.Timestamp.fromMillis(endUtcMs))
    .orderBy('createdAt', 'desc')
    .limit(MAX_REPORT_ORDERS + 1)
    .get();

  const truncated = snap.size > MAX_REPORT_ORDERS;
  const docs = truncated ? snap.docs.slice(0, MAX_REPORT_ORDERS) : snap.docs;

  const all = docs.map(projectOrder);
  const testOrderCount = all.filter((o) => o.isTest).length;

  // Default: test orders are excluded from everything below this line.
  const orders = includeTest ? all : all.filter((o) => !o.isTest);

  return { orders, truncated, testOrderCount, fetchedCount: all.length };
}

/**
 * Aggregates a projected order list into the dashboard/report summary.
 *
 * Order counts include every status. Money includes ONLY paid orders.
 */
function buildSummary(orders) {
  const payment = Object.fromEntries(PAYMENT_STATUSES.map((s) => [s, 0]));
  const fulfillment = Object.fromEntries(FULFILLMENT_STATUSES.map((s) => [s, 0]));

  let merchandiseSales = 0;
  let shippingCollected = 0;
  let grossPaidSales = 0;
  let paidOrders = 0;

  for (const o of orders) {
    if (payment[o.paymentStatus] !== undefined) payment[o.paymentStatus]++;
    if (fulfillment[o.fulfillmentStatus] !== undefined) fulfillment[o.fulfillmentStatus]++;

    // The revenue gate. Everything else contributes to counts only.
    if (o.paymentStatus === 'paid') {
      paidOrders++;
      merchandiseSales += o.subtotal;
      shippingCollected += o.shippingFee;
      grossPaidSales += o.total;
    }
  }

  return {
    totalOrders: orders.length,
    paidOrders,
    awaitingPayment: payment.awaiting_payment,
    pendingReview: payment.pending_review,
    rejected: payment.rejected,

    grossPaidSales,
    merchandiseSales,
    shippingCollected,
    // Average of PAID orders only — dividing by total orders would drag the
    // figure down with unpaid ones and misrepresent basket size.
    averagePaidOrderValue: paidOrders > 0 ? grossPaidSales / paidOrders : 0,

    paymentBreakdown: payment,
    fulfillmentBreakdown: fulfillment,
  };
}

module.exports = {
  MAX_REPORT_ORDERS,
  PAYMENT_STATUSES,
  FULFILLMENT_STATUSES,
  REGION_LABELS,
  derivePaymentMethod,
  destinationLabel,
  projectOrder,
  fetchReportOrders,
  buildSummary,
};
