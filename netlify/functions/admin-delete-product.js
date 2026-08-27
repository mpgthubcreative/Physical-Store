/*
 * Admin (Owner-only): PERMANENTLY delete a product — the Firestore doc,
 * every skuIndex entry it owns, and its Storage images. Irreversible.
 * Normal removal from the storefront is admin-archive-product.js instead.
 *
 * Blocked outright if any order has ever snapshotted this productId
 * (see _shared/orderReferences.js) — a historical order must remain
 * reconstructible even after the live catalog record is gone, and this is
 * the one action that would actually remove the record itself. Archive
 * instead once a product has order history.
 */
const { requireOwner } = require('./_shared/adminAuth');
const { getDb, getBucket } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { releaseAllSkusForProduct } = require('./_shared/productWrite');
const { isProductReferencedByOrders } = require('./_shared/orderReferences');

async function deleteStorageObject(bucket, path) {
  if (!path) return;
  try {
    await bucket.file(path).delete();
  } catch (err) {
    if (err.code !== 404) throw err; // already gone is fine; anything else isn't
  }
}

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireOwner(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const { id } = JSON.parse(event.body || '{}');
  if (!id) return fail(400, 'Missing product id.');

  const db = getDb();
  const ref = db.collection('products').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return fail(404, 'Product not found.');
  const data = snap.data();

  if (await isProductReferencedByOrders(id, db)) {
    return fail(409, 'This product has order history and cannot be permanently deleted. Archive it instead.');
  }

  await releaseAllSkusForProduct(db, id);

  const bucket = getBucket();
  const imagePaths = [data.thumbnail, ...(data.gallery || []), ...(data.variants || []).map((v) => v.stageImage)].filter(Boolean);
  await Promise.all(imagePaths.map((p) => deleteStorageObject(bucket, p)));

  await ref.delete();

  return ok({ id, deleted: true });
});
