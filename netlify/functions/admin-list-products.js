/*
 * Admin: list every product (active and inactive) for the products table.
 * Read-only — no ecommerce logic.
 *
 * ---- Phase 5D.3 diagnostic instrumentation ----
 * Temporary, same pattern as admin-dashboard.js. The response body already
 * measured lightweight (id/title/slug/price/counts only — no descriptions,
 * galleries, customizationConfig, or stage images), so the ~7s reported for
 * the Products page was suspected to be OUTSIDE this endpoint — specifically
 * the frontend boot sequence also awaiting admin-list-collections and
 * admin-list-patches before this call even started (see admin/js/products.js).
 * This _timing block exists to confirm, from THIS endpoint's own numbers,
 * that it is not itself the bottleneck, and to measure it the same way
 * admin-dashboard.js is measured so the two are directly comparable.
 *
 * Records stage names, millisecond durations, a document count, and a byte
 * count only — never product content or any customer/auth data.
 */
const { requireAdminCached } = require('./_shared/adminAuth');
const { getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { publicUrl } = require('./_shared/publicUrl');
const { createTimer } = require('./_shared/timing');

exports.handler = withErrorHandling(async (event) => {
  const timer = createTimer();

  // Read-only endpoint — uses the short-lived admin-status cache (see
  // _shared/adminAuth.js). verifyIdToken() still runs on every call; only
  // the adminUsers/{uid} status read may be served from cache.
  const auth = await requireAdminCached(event, timer);
  if (!auth.ok) return fail(auth.status, auth.error);

  const db = getDb();
  const snap = await timer.time('firestoreQueryMs', () => db.collection('products').orderBy('title').get());

  const mappingStartedAt = Date.now();
  const products = snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      title: d.title,
      slug: d.slug,
      basePrice: d.basePrice,
      active: d.active,
      featured: d.featured,
      badge: d.badge || '',
      customizable: !!d.customizable,
      thumbnailUrl: publicUrl(d.thumbnail),
      variantCount: (d.variants || []).length,
      totalStock: (d.variants || []).reduce((sum, v) => sum + (v.stockQty || 0), 0),
      totalReserved: (d.variants || []).reduce((sum, v) => sum + (v.reservedQty || 0), 0),
    };
  });
  timer.record('productMappingMs', Date.now() - mappingStartedAt);

  // Measures the actual serialization cost of this payload and its size in
  // bytes. The value produced here is discarded — ok() performs the real
  // JSON.stringify of the full response — this is purely a diagnostic
  // measurement of the products array on its own.
  const serializeStartedAt = Date.now();
  const responseBytes = Buffer.byteLength(JSON.stringify(products), 'utf8');
  timer.record('serializationMs', Date.now() - serializeStartedAt);

  return ok({
    products,
    _timing: {
      ...timer.summary(),
      authStatusCacheHit: auth.cacheHit,
      productDocsRead: snap.size,
      responseBytes,
    },
  });
});
