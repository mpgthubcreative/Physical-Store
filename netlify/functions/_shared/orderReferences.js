/*
 * Checks whether any order snapshot references a given productId, patchId,
 * or Storage image path — used by every Owner-only permanent-delete
 * endpoint and by admin-remove-image.js to decide whether a Storage
 * object is safe to physically delete.
 *
 * Firestore's array-contains can only match primitive array entries, not
 * "does any object in order.items have field X" — order.items is an array
 * of rich snapshot objects, not primitives. So create-order.js additionally
 * writes three flat, deduplicated arrays alongside items —
 * referencedProductIds, referencedPatchIds, referencedImagePaths — purely
 * so these lookups are possible. Every order (created after Phase 5C's
 * delete/image protections shipped) carries these; see
 * scripts/backfill-order-references.js for orders created before that.
 */
const { getDb } = require('./firebaseAdmin');

async function isProductReferencedByOrders(productId, db) {
  const snap = await (db || getDb()).collection('orders').where('referencedProductIds', 'array-contains', productId).limit(1).get();
  return !snap.empty;
}

async function isPatchReferencedByOrders(patchId, db) {
  const snap = await (db || getDb()).collection('orders').where('referencedPatchIds', 'array-contains', patchId).limit(1).get();
  return !snap.empty;
}

async function isImagePathReferencedByOrders(path, db) {
  if (!path) return false;
  const snap = await (db || getDb()).collection('orders').where('referencedImagePaths', 'array-contains', path).limit(1).get();
  return !snap.empty;
}

module.exports = { isProductReferencedByOrders, isPatchReferencedByOrders, isImagePathReferencedByOrders };
