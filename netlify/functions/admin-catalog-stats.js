/*
 * GET /api/admin-catalog-stats
 *
 * Admin-only. The Dashboard's "At a glance" catalog numbers, and nothing
 * else.
 *
 * ---- Why this exists ----
 * The Dashboard previously called admin-list-products + admin-list-patches
 * + admin-list-collections just to render four counts and a list of
 * out-of-stock titles. Those three endpoints exist for the CATALOG EDITOR:
 * they read every document in each collection and return full records
 * (patches/collections literally spread the whole document). Doing that on
 * every Dashboard load meant three full-collection reads, growing with the
 * catalog, to produce numbers that fit on one line.
 *
 * This endpoint answers the same questions far more cheaply:
 *   - patches and collections use count() AGGREGATIONS — Firestore counts
 *     server-side and downloads ZERO documents.
 *   - products still needs per-variant stock to find out-of-stock items,
 *     which no aggregation can express, so it reads products with a
 *     .select() PROJECTION — pulling only title/active/variants and
 *     skipping description, gallery, customizationConfig and thumbnails,
 *     which are the large fields.
 *
 * READ-ONLY. No writes, no commerce logic, no catalog mutation.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');

// The dashboard only names a handful before it becomes noise.
const MAX_OUT_OF_STOCK_NAMES = 12;

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const db = getDb();

  const [productsSnap, patchesCount, collectionsCount] = await Promise.all([
    // Projection: only the three fields needed to compute the counts and
    // find out-of-stock products.
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

    // Same definition the previous dashboard used: a product counts as out
    // of stock when every variant's stockQty sums to zero.
    const totalStock = (d.variants || []).reduce((sum, v) => sum + (Number(v.stockQty) || 0), 0);
    if (totalStock === 0) outOfStock.push({ id: doc.id, title: d.title || doc.id });
  });

  return ok({
    productsActive: activeProducts,
    productsTotal: productsSnap.size,
    patches: patchesCount.data().count,
    collections: collectionsCount.data().count,
    outOfStockCount: outOfStock.length,
    outOfStock: outOfStock.slice(0, MAX_OUT_OF_STOCK_NAMES),
  });
});
