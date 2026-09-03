/*
 * The Dashboard's two non-reporting data sets, defined once.
 *
 * Both admin-order-stats.js / admin-catalog-stats.js (the standalone
 * endpoints, kept for compatibility and for any page that wants just one of
 * them) and admin-dashboard.js (the consolidated endpoint) call these. The
 * business definitions — what counts as "to fulfil", what counts as out of
 * stock — therefore exist in exactly one place and cannot drift between the
 * two call paths.
 *
 * READ-ONLY. No writes, no commerce logic.
 */

// The dashboard only names a handful of out-of-stock products before the
// list stops being useful.
const MAX_OUT_OF_STOCK_NAMES = 12;

/**
 * Live operational counters.
 *
 * Uses count() aggregations: Firestore computes these server-side and
 * downloads ZERO documents, so the cost does not grow with order history.
 * These are deliberately NOT date-filtered — they describe what needs
 * action right now.
 */
async function fetchOrderStats(db) {
  const orders = db.collection('orders');

  const [pendingReview, paidUnfulfilled, paidProcessing, total] = await Promise.all([
    orders.where('paymentStatus', '==', 'pending_review').count().get(),
    orders.where('paymentStatus', '==', 'paid').where('fulfillmentStatus', '==', 'unfulfilled').count().get(),
    orders.where('paymentStatus', '==', 'paid').where('fulfillmentStatus', '==', 'processing').count().get(),
    orders.count().get(),
  ]);

  return {
    pendingReviewCount: pendingReview.data().count,
    // Everything paid that is not finished yet — the whole open workload.
    paidAwaitingProcessingCount: paidUnfulfilled.data().count + paidProcessing.data().count,
    // Just the not-yet-started slice, so the "Orders to Fulfill" queue can
    // link to exactly paid + unfulfilled.
    paidUnfulfilledCount: paidUnfulfilled.data().count,
    totalOrdersCount: total.data().count,
  };
}

/**
 * Catalog "at a glance" numbers.
 *
 * patches/collections use count() aggregations (no documents downloaded).
 * products must be read because out-of-stock depends on summing per-variant
 * stock, which no aggregation can express — but it uses a .select()
 * projection so only title/active/variants come back, skipping description,
 * gallery, customizationConfig and image paths.
 */
async function fetchCatalogStats(db) {
  const [productsSnap, patchesCount, collectionsCount] = await Promise.all([
    db.collection('products').select('title', 'active', 'variants').get(),
    db.collection('patches').count().get(),
    db.collection('collections').count().get(),
  ]);

  let activeProducts = 0;
  const outOfStock = [];

  productsSnap.forEach((doc) => {
    const d = doc.data();
    if (d.active !== true) return;
    activeProducts++;

    const totalStock = (d.variants || []).reduce((sum, v) => sum + (Number(v.stockQty) || 0), 0);
    if (totalStock === 0) outOfStock.push({ id: doc.id, title: d.title || doc.id });
  });

  return {
    productsActive: activeProducts,
    productsTotal: productsSnap.size,
    patches: patchesCount.data().count,
    collections: collectionsCount.data().count,
    outOfStockCount: outOfStock.length,
    outOfStock: outOfStock.slice(0, MAX_OUT_OF_STOCK_NAMES),
  };
}

module.exports = { MAX_OUT_OF_STOCK_NAMES, fetchOrderStats, fetchCatalogStats };
