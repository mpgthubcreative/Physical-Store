/*
 * GET /api/admin-order-stats
 *
 * Admin-only. Lightweight operational counters for the Admin dashboard —
 * uses Firestore's count() aggregation (server-side count, no documents
 * downloaded) rather than fetching the whole `orders` collection just to
 * count it.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const db = getDb();
  const orders = db.collection('orders');

  const [pendingReview, paidUnfulfilled, paidProcessing, total] = await Promise.all([
    orders.where('paymentStatus', '==', 'pending_review').count().get(),
    orders.where('paymentStatus', '==', 'paid').where('fulfillmentStatus', '==', 'unfulfilled').count().get(),
    orders.where('paymentStatus', '==', 'paid').where('fulfillmentStatus', '==', 'processing').count().get(),
    orders.count().get(),
  ]);

  return ok({
    pendingReviewCount: pendingReview.data().count,
    // Everything paid that isn't finished yet — the Owner's whole open
    // fulfillment workload.
    paidAwaitingProcessingCount: paidUnfulfilled.data().count + paidProcessing.data().count,
    // Just the not-yet-started slice, so the dashboard's "Orders to Fulfill"
    // queue can link to exactly paid + unfulfilled.
    paidUnfulfilledCount: paidUnfulfilled.data().count,
    totalOrdersCount: total.data().count,
  });
});
