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

  const db = getDb();
  // Settings QR images are never snapshotted into an order, so the
  // historical-order protection below doesn't apply to them.
  const referencedByOrder = entityType === 'settings' ? false : await isImagePathReferencedByOrders(path, db);

  // Detach FIRST, delete second — the same ordering rule as replacing an
  // image in admin-finalize-image-upload.js. If the Storage delete fails
  // midway, the settings document has already stopped referencing the
  // object, so the Owner never sees a QR pointing at something deleted.
  await detachImage({ entityType, entityId, role, variantId: body.variantId, path, actorUid: auth.uid });

  if (!referencedByOrder) {
    try {
      await getBucket().file(path).delete();
    } catch (err) {
      if (err.code !== 404) throw err;
    }
  }

  return ok({ removed: true, physicallyDeleted: !referencedByOrder });
});
