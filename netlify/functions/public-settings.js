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
    // Display values only. checkout.html uses these to SHOW the customer
    // what shipping will cost before they submit — the number that is
    // actually charged is computed independently by create-order.js from
    // these same Firestore settings and is never read from the request.
    shipping: {
      deliveryEnabled: shipping.deliveryEnabled,
      pickupEnabled: shipping.pickupEnabled,
      pickupFee: shipping.pickupFee,
      freeShippingThreshold: shipping.freeShippingThreshold,
      rates: shipping.rates,
    },
    // Whether the store can currently accept an order at all. The customer
    // page uses this to explain itself instead of letting someone fill in a
    // whole checkout form only to be refused on submit.
    checkoutEnabled: payment.checkoutEnabled,
    paymentMethods: sanitizePaymentMethodsForCustomer(payment),
  });
});
