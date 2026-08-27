/*
 * Admin (Owner-only): PERMANENTLY delete a collection. Blocked if any
 * product still lists it in collectionIds, so products never end up
 * referencing a collection that no longer exists.
 */
const { requireOwner } = require('./_shared/adminAuth');
const { getDb, getBucket } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');
  const auth = await requireOwner(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const { id } = JSON.parse(event.body || '{}');
  if (!id) return fail(400, 'Missing collection id.');

  const db = getDb();
  const ref = db.collection('collections').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return fail(404, 'Collection not found.');

  const referencing = await db.collection('products').where('collectionIds', 'array-contains', id).limit(5).get();
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
