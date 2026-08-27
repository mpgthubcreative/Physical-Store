/*
 * Admin: clears the matching Firestore reference (thumbnail/gallery entry/
 * stageImage/patch or collection image) and — ONLY if no historical order
 * ever snapshotted this exact path (see _shared/orderReferences.js) —
 * physically deletes the Storage object too. If an order does reference
 * it, the image is detached from the live catalog record (it stops
 * showing on the storefront/admin) but the Storage object itself is left
 * alone, so that order's admin/customer preview never breaks.
 */
const { requireAdmin } = require('./_shared/adminAuth');
const { getDb, getBucket } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireString } = require('./_shared/validation');
const { validateEntityType, validateRole, detachImage } = require('./_shared/imageEntities');
const { isImagePathReferencedByOrders } = require('./_shared/orderReferences');

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

  const db = getDb();
  const referencedByOrder = await isImagePathReferencedByOrders(path, db);

  if (!referencedByOrder) {
    try {
      await getBucket().file(path).delete();
    } catch (err) {
      if (err.code !== 404) throw err;
    }
  }

  await detachImage({ entityType, entityId, role, variantId: body.variantId, path, actorUid: auth.uid });

  return ok({ removed: true, physicallyDeleted: !referencedByOrder });
});
