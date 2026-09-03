/*
 * The shipping RATE PROVIDER layer — the single place that answers
 * "what does this order cost to ship?".
 *
 * Phase 5D.2 ships exactly one provider: flat regional rates
 * (luzon/visayas/mindanao) read from settings/shipping, plus pickup. No
 * courier API is integrated, deliberately.
 *
 * ---- Why this is its own module ----
 * create-order.js never does shipping arithmetic itself; it asks for a
 * QUOTE and stores the answer. A future version that prices via Lalamove /
 * Grab / J&T / LBC / GoGo Xpress replaces `resolveShippingQuote` (or adds a
 * provider behind it) and NOTHING about order-total logic, the order
 * snapshot, or the payment/inventory engines has to change: the contract is
 * always "(delivery method, destination, subtotal) -> a fee in pesos, plus
 * a label describing where that fee came from".
 *
 * ---- Server-authoritative, always ----
 * Nothing in this module ever reads a fee, rate, subtotal, or total from a
 * browser request. It takes the merchandise subtotal that
 * orderValidation.js computed from live Firestore prices, and the shipping
 * settings this server read from Firestore. A tampered client cannot reach
 * any of these inputs.
 */
const { ValidationError, requireOneOf } = require('./validation');
const { DESTINATION_REGIONS, REGION_LABELS } = require('./settings');

const DELIVERY_METHODS = ['delivery', 'pickup'];

/**
 * Validates the requested delivery method + destination region pair.
 *
 * For delivery: destinationRegion MUST be one of luzon|visayas|mindanao.
 * For pickup:   destinationRegion is forced to null — a region sent
 *               alongside pickup is IGNORED, never used to price anything.
 *               (Ignoring rather than erroring keeps a stale value left in
 *               a browser <select> from blocking a valid pickup order; it
 *               can't affect the fee either way, since pickup pricing never
 *               consults it.)
 */
function validateDestination(deliveryMethod, rawRegion) {
  const method = requireOneOf(deliveryMethod, 'deliveryMethod', DELIVERY_METHODS);
  if (method === 'pickup') return { deliveryMethod: method, destinationRegion: null };

  if (rawRegion === null || rawRegion === undefined || rawRegion === '') {
    throw new ValidationError('Please choose a delivery region (Luzon, Visayas, or Mindanao).');
  }
  // Must actually BE a string. Coercing with String() first would let a
  // non-string (an object with a toString, a boxed value) reach the enum
  // check on the strength of its coercion rather than its real type. JSON
  // can't currently produce such a value here, but pricing input should
  // never depend on that remaining true.
  if (typeof rawRegion !== 'string') {
    throw new ValidationError('destinationRegion must be one of: ' + DESTINATION_REGIONS.join(', ') + '.');
  }
  const destinationRegion = requireOneOf(rawRegion.trim().toLowerCase(), 'destinationRegion', DESTINATION_REGIONS);
  return { deliveryMethod: method, destinationRegion };
}

/**
 * Produces the AUTHORITATIVE shipping fee for an order.
 *
 * @param {object}  args
 * @param {string}  args.deliveryMethod    already validated: 'delivery' | 'pickup'
 * @param {?string} args.destinationRegion already validated: region for delivery, null for pickup
 * @param {number}  args.itemSubtotal      server-computed merchandise subtotal (never from the browser)
 * @param {object}  args.shipping          normalized settings/shipping (see _shared/settings.js)
 * @returns {{ shippingFee:number, rateSource:string, regionLabel:?string, freeShippingApplied:boolean }}
 */
function resolveShippingQuote({ deliveryMethod, destinationRegion, itemSubtotal, shipping }) {
  if (deliveryMethod === 'pickup') {
    if (!shipping.pickupEnabled) throw new ValidationError('Pickup is not currently available.');
    return {
      shippingFee: Number(shipping.pickupFee || 0),
      rateSource: 'pickup',
      regionLabel: null,
      freeShippingApplied: false,
    };
  }

  if (!shipping.deliveryEnabled) {
    throw new ValidationError('Delivery is not currently available. Please choose pickup.');
  }

  const rate = shipping.rates ? shipping.rates[destinationRegion] : null;
  if (rate === null || rate === undefined) {
    throw new ValidationError(
      `Delivery pricing for ${REGION_LABELS[destinationRegion] || destinationRegion} is not yet configured. Please choose pickup or contact us.`
    );
  }

  // Free-shipping rule, stated explicitly: the fee drops to 0 ONLY when a
  // threshold is configured AND the authoritative merchandise subtotal
  // (excluding shipping) reaches it. Otherwise the regional rate applies.
  // The threshold is null/disabled by default.
  const threshold = shipping.freeShippingThreshold;
  if (threshold !== null && threshold !== undefined && itemSubtotal >= Number(threshold)) {
    return {
      shippingFee: 0,
      rateSource: 'free-shipping-threshold',
      regionLabel: REGION_LABELS[destinationRegion] || destinationRegion,
      freeShippingApplied: true,
    };
  }

  return {
    shippingFee: Number(rate),
    rateSource: `regional:${destinationRegion}`,
    regionLabel: REGION_LABELS[destinationRegion] || destinationRegion,
    freeShippingApplied: false,
  };
}

module.exports = { DELIVERY_METHODS, validateDestination, resolveShippingQuote };
