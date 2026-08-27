/*
 * Admin: list every product (active and inactive) for the products table.
 * Read-only — no ecommerce logic.
 */
const { requireAdmin } = require('./_shared/adminAuth');
const { getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { publicUrl } = require('./_shared/publicUrl');

exports.handler = withErrorHandling(async (event) => {
  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const db = getDb();
  const snap = await db.collection('products').orderBy('title').get();
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
    };
  });

  return ok({ products });
});
