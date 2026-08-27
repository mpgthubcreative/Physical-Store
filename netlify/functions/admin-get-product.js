/*
 * Admin: fetch one product (full detail, incl. inactive) for the edit form.
 */
const { requireAdmin } = require('./_shared/adminAuth');
const { getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { publicUrl } = require('./_shared/publicUrl');

exports.handler = withErrorHandling(async (event) => {
  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const id = (event.queryStringParameters || {}).id;
  if (!id) return fail(400, 'Missing product id.');

  const db = getDb();
  const snap = await db.collection('products').doc(id).get();
  if (!snap.exists) return fail(404, 'Product not found.');

  const d = snap.data();
  return ok({
    product: {
      id: snap.id,
      ...d,
      thumbnailUrl: publicUrl(d.thumbnail),
      galleryUrls: (d.gallery || []).map(publicUrl),
      variants: (d.variants || []).map((v) => ({ ...v, stageImageUrl: publicUrl(v.stageImage) })),
    },
  });
});
