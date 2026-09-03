/* Admin: list every collection (active and inactive). */
const { requireAdminCached } = require('./_shared/adminAuth');
const { getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { publicUrl } = require('./_shared/publicUrl');

exports.handler = withErrorHandling(async (event) => {
  const auth = await requireAdminCached(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const db = getDb();
  const snap = await db.collection('collections').orderBy('sortOrder').get();
  const collections = snap.docs.map((doc) => {
    const d = doc.data();
    return { id: doc.id, ...d, imageUrl: publicUrl(d.image) };
  });

  return ok({ collections, _timing: { authStatusCacheHit: auth.cacheHit } });
});
