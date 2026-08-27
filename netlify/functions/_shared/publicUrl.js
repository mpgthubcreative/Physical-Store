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
  // Firebase Storage Security Rules (storage.rules) govern the Firebase-
  // mediated endpoint below, not the raw GCS API (storage.googleapis.com) —
  // that endpoint is IAM-controlled and would 403/503 for anonymous reads
  // regardless of what storage.rules allows. alt=media serves the raw bytes
  // directly; no download token is needed because the rule below allows
  // public read.
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;
}

module.exports = { publicUrl };
