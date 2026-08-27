/*
 * POST /api/get-order
 *
 * PUBLIC — the raw access token IS the authentication. Deliberately POST,
 * not GET: the token travels only in the request body, never a URL query
 * string, so it can never land in a browser history entry, a referer
 * header, or a server access log. The frontend keeps the token in the
 * `order.html#token=...` URL FRAGMENT (never sent to any server) and reads
 * it client-side to build this request body.
 *
 * Returns only sanitized, customer-safe fields — never accessTokenHash,
 * raw Firestore doc/order IDs, reviewedBy, or any other admin/audit field.
 * Image fields are always resolved to public URLs here, server-side —
 * this endpoint never exposes a raw Storage path (same rule the public
 * catalog follows).
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { requireString } = require('./_shared/validation');
const { isValidAccessToken, hashToken, hashesMatch } = require('./_shared/orderSecurity');
const { getPaymentSettings, sanitizePaymentMethodsForCustomer } = require('./_shared/settings');
const { publicUrl } = require('./_shared/publicUrl');

function sanitizeItem(item) {
  const customization = item.customization
    ? {
        rendererVersion: item.customization.rendererVersion,
        boundary: item.customization.boundary,
        variant: { hex: item.customization.variant.hex, stageImageUrl: publicUrl(item.customization.variant.stageImagePath) },
        text: item.customization.text,
        patches: (item.customization.patches || []).map((p) => ({
          patchName: p.patchName,
          x: p.x,
          y: p.y,
          z: p.z,
          widthPct: p.widthPct,
          heightPct: p.heightPct,
          hex: p.hex,
          imageUrl: publicUrl(p.imagePath),
        })),
      }
    : null;

  return {
    productName: item.productName,
    variantName: item.variantName,
    quantity: item.quantity,
    unitPrice: item.pricing.unitPrice,
    lineTotal: item.pricing.lineTotal,
    thumbnailUrl: publicUrl(item.thumbnailImagePath),
    customization,
  };
}

function latestRejection(order) {
  const attempts = order.paymentAttempts || [];
  const last = attempts[attempts.length - 1];
  if (last && last.status === 'rejected') {
    return { code: last.rejectionCode, note: last.rejectionNote || null };
  }
  return null;
}

function sanitizeOrder(order) {
  return {
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    deliveryMethod: order.deliveryMethod,
    items: (order.items || []).map(sanitizeItem),
    pricing: order.pricing,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    // Absent on legacy isTest orders (predate Phase 5D) — order.js treats
    // that the same as 'reserved' (show the normal payment form), since
    // those orders never had reservation-expiry semantics to begin with.
    inventoryStatus: order.inventoryStatus || null,
    latestRejection: latestRejection(order),
  };
}

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const body = JSON.parse(event.body || '{}');
  const token = requireString(body.token, 'token', { maxLength: 100 });
  if (!isValidAccessToken(token)) return fail(404, 'Order not found.');

  const db = getDb();
  const hash = hashToken(token);
  const snap = await db.collection('orders').where('accessTokenHash', '==', hash).limit(1).get();
  if (snap.empty) return fail(404, 'Order not found.');

  const order = snap.docs[0].data();
  if (!hashesMatch(hash, order.accessTokenHash)) return fail(404, 'Order not found.');

  const paymentSettings = await getPaymentSettings(db);
  return ok({ order: sanitizeOrder(order), paymentMethods: sanitizePaymentMethodsForCustomer(paymentSettings) });
});
