/*
 * Firestore only ever stores a Storage OBJECT PATH for an image (e.g.
 * "product-images/pouch1/thumbnail-...jpg"), never a full URL. The public
 * URL is derived on read, here, in exactly one place — so removing/
 * replacing an image is just deleting the Storage object and clearing the
 * path field, never parsing a stored URL back into a path.
 */
function publicUrl(path) {
  if (!path) return null;
  const bucket = process.env.FIREBASE_STORAGE_BUCKET;
  return `https://storage.googleapis.com/${bucket}/${path}`;
}

module.exports = { publicUrl };
