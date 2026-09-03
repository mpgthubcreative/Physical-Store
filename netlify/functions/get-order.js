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
 * Phase 5E: `token` may be EITHER the primary order-access token (64 hex
 * chars) OR a scoped email access token (always contains a '.') minted by
 * the scheduled email processor — see _shared/orderTokenAuth.js, which
 * disambiguates by shape and enforces the 'order:read' scope on the email
 * path. Every lifecycle email's "View order" link uses that token, since
 * the server never holds a raw primary token to put in an email.
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
const { resolveOrderByToken, TOKEN_FIELD_MAX_LENGTH } = require('./_shared/orderTokenAuth');
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
    // Phase 5D.2. Absent on every order created before this phase — sent as
    // null so the customer page can simply omit the region line rather than
    // render "undefined". Historical orders are never backfilled.
    destinationRegion: order.destinationRegion || null,
    items: (order.items || []).map(sanitizeItem),
    // The frozen snapshot exactly as stored. Never recomputed from current
    // settings — an order placed when Luzon cost ₱150 still shows ₱150.
    pricing: order.pricing,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    courier: order.courier || null,
    trackingNumber: order.trackingNumber || null,
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
  const token = requireString(body.token, 'token', { maxLength: TOKEN_FIELD_MAX_LENGTH });

  const db = getDb();
  const resolved = await resolveOrderByToken(db, token, 'order:read');
  if (!resolved.ok) return fail(404, 'Order not found.');
  const { order } = resolved;

  const paymentSettings = await getPaymentSettings(db);
  return ok({ order: sanitizeOrder(order), paymentMethods: sanitizePaymentMethodsForCustomer(paymentSettings) });
});
