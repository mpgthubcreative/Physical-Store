/*
 * GET /api/admin-get-order?id=
 *
 * Admin-only. Full order detail for the Admin order-detail page — every
 * payment attempt, the full audit history, and every line's customization
 * snapshot with image paths resolved to URLs. This renders the historical
 * ORDER SNAPSHOT, never live catalog data — an order created before a
 * product/patch/price/image changed still shows exactly what the customer
 * saw at order time.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { requireString } = require('./_shared/validation');
const { publicUrl } = require('./_shared/publicUrl');

function withResolvedImages(item) {
  return {
    ...item,
    thumbnailUrl: publicUrl(item.thumbnailImagePath),
    customization: item.customization
      ? {
          ...item.customization,
          variant: { ...item.customization.variant, stageImageUrl: publicUrl(item.customization.variant.stageImagePath) },
          patches: (item.customization.patches || []).map((p) => ({ ...p, imageUrl: publicUrl(p.imagePath) })),
        }
      : null,
  };
}

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const params = event.queryStringParameters || {};
  const id = requireString(params.id, 'id', { maxLength: 100 });

  const db = getDb();
  const snap = await db.collection('orders').doc(id).get();
  if (!snap.exists) return fail(404, 'Order not found.');

  const order = snap.data();
  return ok({
    order: {
      orderId: snap.id,
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      customerMobile: order.customerMobile,
      deliveryMethod: order.deliveryMethod,
      deliveryAddress: order.deliveryAddress,
      orderNotes: order.orderNotes,
      items: (order.items || []).map(withResolvedImages),
      pricing: order.pricing,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      paymentAttempts: order.paymentAttempts || [],
      history: order.history || [],
      // What this order currently protects from permanent deletion (see
      // _shared/orderReferences.js) — genuinely useful context for an
      // Owner/Admin who hits a 409 trying to delete a product/patch.
      referencedProductIds: order.referencedProductIds || [],
      referencedPatchIds: order.referencedPatchIds || [],
      referencedImagePaths: order.referencedImagePaths || [],
      isTest: order.isTest === true,
      createdAt: order.createdAt || null,
      updatedAt: order.updatedAt || null,
    },
  });
});
