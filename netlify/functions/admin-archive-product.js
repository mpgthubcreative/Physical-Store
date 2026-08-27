/*
 * Admin: soft-deactivate a product (active: false). Reversible — see
 * admin-reactivate-product.js. This is the normal "remove from storefront"
 * action; permanent deletion is a separate, Owner-only function.
 */
const { requireAdmin } = require('./_shared/adminAuth');
const { getDb, admin } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const { id } = JSON.parse(event.body || '{}');
  if (!id) return fail(400, 'Missing product id.');

  const db = getDb();
  const ref = db.collection('products').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return fail(404, 'Product not found.');

  await ref.update({
    active: false,
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: auth.uid,
  });

  return ok({ id, active: false });
});
