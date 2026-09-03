/*
 * Admin: step 1 of the direct-upload flow. Validates the request, confirms
 * the target entity (and variant, for a stageImage) actually exists, then
 * returns a short-lived v4-signed Storage URL the browser uploads straight
 * to — the image bytes never pass through this function or Netlify at all.
 *
 * No Storage path is ever trusted from the browser after this point:
 * admin-finalize-image-upload.js re-derives/re-validates everything before
 * attaching the result to a Firestore doc.
 */
const { requireAdmin } = require('./_shared/adminAuth');
const { getBucket } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireString, requireImageContentType } = require('./_shared/validation');
const { validateEntityType, validateRole, loadEntityForImage, buildImagePath } = require('./_shared/imageEntities');

const MAX_DECLARED_BYTES = 8 * 1024 * 1024; // 8MB — a first-line, client-declared check only; see finalize for the real one

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');
  const entityType = validateEntityType(body.entityType);
  const entityId = requireString(body.entityId, 'entityId', { maxLength: 100 });
  const role = validateRole(entityType, body.role, body.variantId, entityId);
  const contentType = requireImageContentType(body.contentType);
  const filename = requireString(body.filename, 'filename', { maxLength: 150 });

  if (body.sizeBytes != null && Number(body.sizeBytes) > MAX_DECLARED_BYTES) {
    throw new ValidationError(`Image is too large (max ${MAX_DECLARED_BYTES / 1024 / 1024}MB).`);
  }

  await loadEntityForImage({ entityType, entityId, role, variantId: body.variantId });

  const path = buildImagePath({ entityType, entityId, role, variantId: body.variantId, filename });

  const [uploadUrl] = await getBucket()
    .file(path)
    .getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 5 * 60 * 1000, contentType });

  return ok({ uploadUrl, path, method: 'PUT', contentType });
});
