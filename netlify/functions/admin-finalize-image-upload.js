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
const ALLOWED_PREFIXES = ['product-images/', 'patch-images/', 'collection-images/'];

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');
  const entityType = validateEntityType(body.entityType);
  const entityId = requireString(body.entityId, 'entityId', { maxLength: 100 });
  const role = validateRole(entityType, body.role, body.variantId);
  const path = requireString(body.path, 'path', { maxLength: 400 });

  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    throw new ValidationError('Unexpected image path.');
  }
  // The path must actually belong to this entityId — reject anything else,
  // regardless of what the browser claims about entityType/entityId.
  const expectedPrefix = { product: `product-images/${entityId}/`, patch: `patch-images/${entityId}/`, collection: `collection-images/${entityId}/` }[entityType];
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

  await attachImage({ entityType, entityId, role, variantId: body.variantId, path, actorUid: auth.uid });

  return ok({ path, url: publicUrl(path) });
});
