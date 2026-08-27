/*
 * Admin (Owner-only): PERMANENTLY delete a product — the Firestore doc,
 * every skuIndex entry it owns, and its Storage images. Irreversible.
 * Normal removal from the storefront is admin-archive-product.js instead.
 *
 * FUTURE (once Orders exist): this must first check whether any order
 * references this productId and refuse to delete if so — permanently
 * deleting a product that a historical order snapshots would break that
 * order's admin preview. There is no orders collection yet, so that check
 * doesn't exist yet; flagging here so it isn't forgotten when Orders ship.
 */
const { requireOwner } = require('./_shared/adminAuth');
const { getDb, getBucket } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { releaseAllSkusForProduct } = require('./_shared/productWrite');

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

  await releaseAllSkusForProduct(db, id);

  const bucket = getBucket();
  const imagePaths = [data.thumbnail, ...(data.gallery || []), ...(data.variants || []).map((v) => v.stageImage)].filter(Boolean);
  await Promise.all(imagePaths.map((p) => deleteStorageObject(bucket, p)));

  await ref.delete();

  return ok({ id, deleted: true });
});
