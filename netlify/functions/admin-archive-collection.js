/* Admin: soft-deactivate a collection (active: false). Reversible. */
const { requireAdmin } = require('./_shared/adminAuth');
const { getDb, admin } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');
  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const { id } = JSON.parse(event.body || '{}');
  if (!id) return fail(400, 'Missing collection id.');

  const db = getDb();
  const ref = db.collection('collections').doc(id);
  if (!(await ref.get()).exists) return fail(404, 'Collection not found.');

  await ref.update({
    active: false,
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: auth.uid,
  });
  return ok({ id, active: false });
});
