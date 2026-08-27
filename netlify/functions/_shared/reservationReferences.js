/*
 * Checks whether a productId/patchId is currently held by an active or
 * locked inventory reservation — used by admin-delete-product.js and
 * admin-delete-patch.js alongside the existing historical-order-reference
 * check (_shared/orderReferences.js). A product/patch that has never
 * appeared in a completed historical order could still be reserved right
 * now by an unpaid customer; permanent deletion must be blocked in that
 * state too (Phase 5D correction #10).
 *
 * Deliberately does NOT filter by status in the Firestore query itself —
 * `resourceProductIds`/`resourcePatchIds` are flat arrays (array-contains
 * needs a real Firestore field to match; `resources[]` holds rich objects
 * Firestore can't partial-match, same limitation _shared/orderReferences.js
 * already works around). Combining array-contains with a status filter
 * would need its own composite index; at this store's scale, reading every
 * reservation that ever referenced the resource and filtering status in
 * memory is simpler and avoids provisioning more indexes than necessary.
 */
const { getDb } = require('./firebaseAdmin');

const BLOCKING_STATUSES = new Set(['active', 'locked']);

async function isProductActivelyReserved(productId, db) {
  const snap = await (db || getDb()).collection('inventoryReservations').where('resourceProductIds', 'array-contains', productId).get();
  return snap.docs.some((d) => BLOCKING_STATUSES.has(d.data().status));
}

async function isPatchActivelyReserved(patchId, db) {
  const snap = await (db || getDb()).collection('inventoryReservations').where('resourcePatchIds', 'array-contains', patchId).get();
  return snap.docs.some((d) => BLOCKING_STATUSES.has(d.data().status));
}

module.exports = { isProductActivelyReserved, isPatchActivelyReserved };
