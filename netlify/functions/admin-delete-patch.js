/*
 * Admin (Owner-only): PERMANENTLY delete a patch. Blocked if any product —
 * active or archived — still lists it in customizationConfig.availablePatchIds,
 * so a product's customizer config never ends up referencing a patch that
 * no longer exists. Also blocked if any order has ever snapshotted this
 * patchId (see _shared/orderReferences.js) — same historical-integrity
 * reasoning as admin-delete-product.js. Archive instead once a patch has
 * order history. Also blocked (Phase 5D correction #10) if any
 * active/locked inventory reservation currently holds this patch.
 */
const { requireOwner } = require('./_shared/adminAuth');
const { getDb, getBucket } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { isPatchReferencedByOrders } = require('./_shared/orderReferences');
const { isPatchActivelyReserved } = require('./_shared/reservationReferences');

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

  if (await isPatchReferencedByOrders(id, db)) {
    return fail(409, 'This patch has order history and cannot be permanently deleted. Archive it instead.');
  }
  if (await isPatchActivelyReserved(id, db)) {
    return fail(409, 'This patch is currently reserved by an unpaid customer order and cannot be permanently deleted. Archive it instead.');
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
