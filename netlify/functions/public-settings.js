/*
 * GET /api/public-settings
 *
 * PUBLIC. Returns only the customer-relevant slice of settings/shipping
 * and settings/payment — lets checkout.html know whether delivery is
 * enabled and what it costs, and lets the payment page know which
 * payment methods to show, all without hard-coding any of it into
 * frontend JS. Never exposes anything admin-only.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { getShippingSettings, getPaymentSettings, sanitizePaymentMethodsForCustomer } = require('./_shared/settings');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const db = getDb();
  const [shipping, payment] = await Promise.all([getShippingSettings(db), getPaymentSettings(db)]);

  return ok({
    shipping: {
      deliveryEnabled: shipping.deliveryEnabled,
      flatRateDelivery: shipping.flatRateDelivery,
      freeShippingThreshold: shipping.freeShippingThreshold,
      pickupEnabled: shipping.pickupEnabled,
      pickupFee: shipping.pickupFee,
    },
    paymentMethods: sanitizePaymentMethodsForCustomer(payment),
  });
});
