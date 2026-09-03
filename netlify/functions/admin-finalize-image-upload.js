/*
 * Admin: step 2 of the direct-upload flow. Verifies the object the browser
 * just PUT to Storage actually exists, is a real image, and isn't
 * suspiciously large — only THEN attaches it to the Firestore doc. Never
 * trusts that a client-reported "I uploaded it" claim is true.
 */
const { requireAdmin } = require('./_shared/adminAuth');
const { getBucket } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireString } = require('./_shared/validation');
const { publicUrl } = require('./_shared/publicUrl');
const { validateEntityType, validateRole, attachImage } = require('./_shared/imageEntities');

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_PREFIXES = ['product-images/', 'patch-images/', 'collection-images/', 'settings-images/'];

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');
  const entityType = validateEntityType(body.entityType);
  const entityId = requireString(body.entityId, 'entityId', { maxLength: 100 });
  const role = validateRole(entityType, body.role, body.variantId, entityId);
  const path = requireString(body.path, 'path', { maxLength: 400 });

  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    throw new ValidationError('Unexpected image path.');
  }
  // The path must actually belong to this entityId — reject anything else,
  // regardless of what the browser claims about entityType/entityId.
  const expectedPrefix = {
    product: `product-images/${entityId}/`,
    patch: `patch-images/${entityId}/`,
    collection: `collection-images/${entityId}/`,
    settings: `settings-images/${entityId}/`,
  }[entityType];
  if (!path.startsWith(expectedPrefix)) {
    throw new ValidationError('Path does not match the given entity.');
  }

  const file = getBucket().file(path);
  const [exists] = await file.exists();
  if (!exists) throw new ValidationError('Upload not found — it may have failed or expired.');

  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size || 0);
  if (size > MAX_BYTES) {
    await file.delete().catch(() => {});
    throw new ValidationError(`Uploaded image is too large (max ${MAX_BYTES / 1024 / 1024}MB).`);
  }
  if (!String(metadata.contentType || '').startsWith('image/')) {
    await file.delete().catch(() => {});
    throw new ValidationError('Uploaded file is not an image.');
  }

  const { previousPath } = (await attachImage({ entityType, entityId, role, variantId: body.variantId, path, actorUid: auth.uid })) || {};

  // Replacing a settings QR: only NOW, with Firestore already pointing at
  // the new object, is it safe to remove the one it displaced. Done in this
  // order so an interrupted replace can only ever leave an unreferenced
  // orphan — never a settings document pointing at a deleted asset.
  // Best-effort: a failed cleanup must not fail the upload the Owner just
  // completed successfully.
  //
  // Deliberately settings-only. Catalog images (product/patch/collection)
  // keep their existing behavior, where admin-remove-image.js is the single
  // place that decides whether an object may be physically deleted — it
  // checks _shared/orderReferences.js first so a historical order's
  // snapshot preview never breaks. QR images are never referenced by an
  // order snapshot, so that protection doesn't apply to them.
  let replacedPreviousObject = false;
  if (entityType === 'settings' && previousPath && previousPath !== path) {
    try {
      await getBucket().file(previousPath).delete();
      replacedPreviousObject = true;
    } catch (err) {
      if (err.code !== 404) console.error('QR cleanup failed for', previousPath, err.message);
    }
  }

  return ok({ path, url: publicUrl(path), replacedPreviousObject });
});
