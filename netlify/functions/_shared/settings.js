/*
 * Reads settings/shipping and settings/payment — configuration, not
 * secrets. These live in Firestore (not env vars, not hard-coded frontend
 * JS) specifically so the Owner can change delivery pricing and payment
 * instructions without a code deploy. There is no admin editor UI yet
 * (Phase 5C defers that) — for now these docs are written via
 * scripts/seed-settings.js or the Firebase console; every reader here
 * degrades to a safe, inert default if the doc doesn't exist yet, so
 * nothing breaks before the Owner configures real values.
 */
const { getDb } = require('./firebaseAdmin');

const DEFAULT_SHIPPING = {
  deliveryEnabled: false,
  flatRateDelivery: null,
  freeShippingThreshold: null,
  pickupEnabled: true,
  pickupFee: 0,
};

// No payment methods enabled until the Owner configures real ones —
// checkout/payment pages must never invent a method to display.
const DEFAULT_PAYMENT = { methods: [] };

async function getShippingSettings(db) {
  const snap = await (db || getDb()).collection('settings').doc('shipping').get();
  return snap.exists ? { ...DEFAULT_SHIPPING, ...snap.data() } : { ...DEFAULT_SHIPPING };
}

async function getPaymentSettings(db) {
  const snap = await (db || getDb()).collection('settings').doc('payment').get();
  return snap.exists ? { ...DEFAULT_PAYMENT, ...snap.data() } : { ...DEFAULT_PAYMENT };
}

/** Only the fields a customer-facing page may ever see — never internal/admin-only config. */
function sanitizePaymentMethodsForCustomer(paymentSettings) {
  return (paymentSettings.methods || [])
    .filter((m) => m && m.enabled === true)
    .map((m) => ({
      id: m.id,
      label: m.label,
      accountName: m.accountName || null,
      accountNumber: m.accountNumber || null,
      bankName: m.bankName || null,
      instructions: m.instructions || null,
    }));
}

module.exports = { getShippingSettings, getPaymentSettings, sanitizePaymentMethodsForCustomer, DEFAULT_SHIPPING, DEFAULT_PAYMENT };
