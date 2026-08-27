/*
 * GET /api/admin-check-order-reference?productId=&patchId=&imagePath=
 *
 * Admin-only, read-only. Reports whether a given productId/patchId/
 * imagePath is currently referenced by any order — i.e. whether
 * admin-delete-product.js / admin-delete-patch.js / admin-remove-image.js
 * would block/detach-only for it right now. Never deletes or modifies
 * anything; exists purely so this can be verified without ever calling a
 * destructive endpoint against real data.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { isProductReferencedByOrders, isPatchReferencedByOrders, isImagePathReferencedByOrders } = require('./_shared/orderReferences');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const params = event.queryStringParameters || {};
  const db = getDb();

  const result = {};
  if (params.productId) result.productReferenced = await isProductReferencedByOrders(params.productId, db);
  if (params.patchId) result.patchReferenced = await isPatchReferencedByOrders(params.patchId, db);
  if (params.imagePath) result.imageReferenced = await isImagePathReferencedByOrders(params.imagePath, db);

  return ok(result);
});
