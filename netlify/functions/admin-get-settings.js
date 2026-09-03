/*
 * GET /api/admin-get-settings
 *
 * Admin-only (Owner AND Admin may READ). Returns the normalized
 * settings/shipping + settings/payment for the Admin -> Settings screen,
 * including which storage shape each doc is currently in so the Owner can
 * see at a glance whether the store is still on the pre-5D.2 legacy shape.
 *
 * WRITE permission is split and enforced in the two save endpoints, not
 * here: shipping is Owner+Admin (admin-save-shipping-settings.js), payment
 * and the checkout master switch are Owner-only
 * (admin-save-payment-settings.js). `canEditPayment` below is returned so
 * the UI can disable those controls for an Admin — that is UX only; the
 * server re-checks with requireOwner() regardless of what the client does.
 *
 * QR images are returned as BOTH the stored Storage path (needed to replace
 * or remove the object) and a resolved display URL — this is the admin
 * view, where the path is legitimately useful. The customer-facing
 * projection in public-settings.js/get-order.js never exposes the path.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { requireAdminCached } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { getShippingSettings, getPaymentSettings } = require('./_shared/settings');
const { publicUrl } = require('./_shared/publicUrl');

/**
 * Builds the form model for one payment method.
 *
 * `raw` is the new-shape settings/payment.gcash|bank object, which is
 * ABSENT on a store still running the pre-5D.2 `methods[]` shape. In that
 * case we fall back to `fallback` — the same method as resolved out of the
 * legacy array by the normalizer.
 *
 * This matters for more than display: without it, a legacy store would open
 * Settings, see the method switched OFF (because the new-shape object does
 * not exist yet), and saving would write enabled:false — which the
 * normalizer treats as authoritative and would silently disable a payment
 * method that was working. Prefilling from the legacy config means opening
 * and saving Settings CARRIES the old configuration forward into the new
 * shape instead of blanking it.
 */
function methodConfig(raw, fallback) {
  const data = raw && typeof raw === 'object' ? raw : fallback || {};
  const qrImagePath = data.qrImagePath || null;
  return {
    enabled: data.enabled === true,
    accountName: data.accountName || '',
    accountNumber: data.accountNumber || '',
    mobileNumber: data.mobileNumber || data.accountNumber || '',
    bankName: data.bankName || '',
    instructions: data.instructions || '',
    qrImagePath,
    qrImageUrl: qrImagePath ? publicUrl(qrImagePath) : null,
    // True when these values came from the legacy methods[] array rather
    // than the new shape — the UI flags this so the Owner understands that
    // saving migrates the method rather than changing it.
    fromLegacy: !(raw && typeof raw === 'object') && !!fallback,
  };
}

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdminCached(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const db = getDb();
  const [shipping, payment] = await Promise.all([getShippingSettings(db), getPaymentSettings(db)]);

  return ok({
    role: auth.role,
    canEditPayment: auth.role === 'owner',
    shipping: {
      deliveryEnabled: shipping.deliveryEnabled,
      pickupEnabled: shipping.pickupEnabled,
      pickupFee: shipping.pickupFee,
      freeShippingThreshold: shipping.freeShippingThreshold,
      rates: shipping.rates,
      // Which shape drove `rates`: 'regional' (fully configured),
      // 'legacy-flat' (still on the pre-5D.2 flatRateDelivery),
      // 'partial', or 'unconfigured'.
      ratesSource: shipping.ratesSource,
      legacyFlatRateDelivery: shipping.legacyFlatRateDelivery,
    },
    payment: {
      checkoutEnabled: payment.checkoutEnabled,
      // `payment.methods` is the merged view, so these fallbacks already
      // reflect any legacy methods[] entry for the same id.
      gcash: methodConfig(payment.gcash, payment.methods.find((m) => m.id === 'gcash')),
      bank: methodConfig(payment.bank, payment.methods.find((m) => m.id === 'bank_transfer')),
      // Only legacy entries the gcash/bank cards do NOT cover (e.g. a Maya
      // method configured before this phase). Surfaced read-only so the
      // Owner can see nothing was silently dropped — the two ids above are
      // excluded because they are already editable as full cards.
      legacyMethods: payment.legacyMethods
        .filter((m) => m && m.id !== 'gcash' && m.id !== 'bank_transfer')
        .map((m) => ({
          id: m.id,
          label: m.label || m.id,
          enabled: m.enabled === true,
        })),
      hasNewShape: payment.hasNewShape,
    },
    _timing: { authStatusCacheHit: auth.cacheHit },
  });
});
