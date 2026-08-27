/*
 * Admin (Owner-only): PERMANENTLY delete a patch. Blocked if any product —
 * active or archived — still lists it in customizationConfig.availablePatchIds,
 * so a product's customizer config never ends up referencing a patch that
 * no longer exists.
 *
 * FUTURE (once Orders exist): also block/flag if any historical order line
 * references this patchId, same reasoning as admin-delete-product.js.
 */
const { requireOwner } = require('./_shared/adminAuth');
const { getDb, getBucket } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');
  const auth = await requireOwner(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const { id } = JSON.parse(event.body || '{}');
  if (!id) return fail(400, 'Missing patch id.');

  const db = getDb();
  const ref = db.collection('patches').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return fail(404, 'Patch not found.');

  const referencing = await db
    .collection('products')
    .where('customizationConfig.availablePatchIds', 'array-contains', id)
    .limit(5)
    .get();
  if (!referencing.empty) {
    const titles = referencing.docs.map((d) => d.data().title).join(', ');
    return fail(409, `Cannot delete — still assigned to: ${titles}. Remove it from those products first.`);
  }

  const bucket = getBucket();
  const image = snap.data().image;
  if (image) {
    try {
      await bucket.file(image).delete();
    } catch (err) {
      if (err.code !== 404) throw err;
    }
  }

  await ref.delete();
  return ok({ id, deleted: true });
});
