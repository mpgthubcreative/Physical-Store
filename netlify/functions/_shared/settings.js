/*
 * Reads settings/shipping and settings/payment — configuration, not
 * secrets. These live in Firestore (not env vars, not hard-coded frontend
 * JS) specifically so the Owner can change delivery pricing and payment
 * instructions without a code deploy. Since Phase 5D.2 they are editable
 * from Admin -> Settings; scripts/seed-settings.js still works for
 * bootstrapping. Every reader here degrades to a safe, inert default if a
 * doc does not exist yet, so nothing breaks before the Owner configures
 * real values.
 *
 * ---- Phase 5D.2: DUAL-SHAPE, NON-DESTRUCTIVE READERS ----
 * Production already holds the Phase 5C shapes (shipping.flatRateDelivery,
 * payment.methods[]). Rather than replace them, this module normalizes BOTH
 * the old and new shapes into one canonical in-memory object. Nothing here
 * ever deletes or rewrites a legacy field — the migration script
 * (scripts/migrate-settings-5d2.js) is purely ADDITIVE and, because of the
 * normalization below, entirely optional for correctness: this code runs
 * correctly against completely un-migrated production data.
 *
 *   shipping: `rates: {luzon, visayas, mindanao}` wins when present and
 *   valid. Otherwise a legacy numeric `flatRateDelivery` is synthesized
 *   into all three regions — i.e. exactly today's single-flat-rate
 *   behavior, preserved byte-for-byte. Otherwise delivery is unconfigured
 *   (all null) and create-order.js refuses delivery.
 *
 *   payment: legacy `methods[]` entries pass through untouched; a new-shape
 *   `gcash`/`bank` object OVERLAYS the matching canonical id when present,
 *   so once the Owner saves via Admin -> Settings the new shape is
 *   authoritative for those two methods while any other legacy method the
 *   Owner may have configured keeps working.
 *
 * ---- checkoutEnabled fails closed ----
 * A missing/non-true `checkoutEnabled` is ALWAYS read as false. The store
 * can never become purchasable merely because payment account details were
 * filled in, or because the settings doc predates this field.
 */
const { getDb } = require('./firebaseAdmin');
const { publicUrl } = require('./publicUrl');

const DESTINATION_REGIONS = ['luzon', 'visayas', 'mindanao'];
const REGION_LABELS = { luzon: 'Luzon', visayas: 'Visayas', mindanao: 'Mindanao' };

// Inert until the Owner configures real values: no delivery, no rates.
const DEFAULT_SHIPPING = {
  deliveryEnabled: false,
  pickupEnabled: true,
  pickupFee: 0,
  freeShippingThreshold: null,
  rates: { luzon: null, visayas: null, mindanao: null },
};

// Checkout OFF and no payment method enabled until the Owner configures
// real ones — checkout/payment pages must never invent a method to display,
// and create-order.js must never accept an order, before that.
const DEFAULT_PAYMENT = { checkoutEnabled: false, gcash: null, bank: null, methods: [] };

/** A rate is only usable if it is a finite, non-negative number. Anything else (null, '', 'abc', -5) reads as unconfigured. */
function usableRate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Normalizes either settings/shipping shape into one canonical object.
 * `ratesSource` tells the Admin UI (and the verification script) which
 * shape actually drove the result, so a pre-migration store is obvious
 * rather than silently indistinguishable from a configured one.
 */
function normalizeShippingSettings(raw) {
  const data = raw || {};
  const legacyFlat = usableRate(data.flatRateDelivery);

  const regional = {};
  let regionalCount = 0;
  for (const region of DESTINATION_REGIONS) {
    const value = usableRate(data.rates ? data.rates[region] : null);
    regional[region] = value;
    if (value !== null) regionalCount++;
  }

  let rates;
  let ratesSource;
  if (regionalCount === DESTINATION_REGIONS.length) {
    rates = regional;
    ratesSource = 'regional';
  } else if (regionalCount > 0) {
    // Partially configured regional rates: fill only the gaps from the
    // legacy flat rate (if any). A region left null means delivery to it is
    // refused — never silently free, never silently guessed.
    rates = {};
    for (const region of DESTINATION_REGIONS) rates[region] = regional[region] !== null ? regional[region] : legacyFlat;
    ratesSource = 'partial';
  } else if (legacyFlat !== null) {
    rates = {};
    for (const region of DESTINATION_REGIONS) rates[region] = legacyFlat;
    ratesSource = 'legacy-flat';
  } else {
    rates = { luzon: null, visayas: null, mindanao: null };
    ratesSource = 'unconfigured';
  }

  const pickupFee = usableRate(data.pickupFee);

  // A free-shipping threshold of 0 means "disabled", NOT "everything ships
  // free". Treating 0 as a live threshold would make `subtotal >= 0` true
  // for every order and silently bypass every regional rate — the whole
  // shipping table would stop being charged with nothing appearing broken.
  // An Owner who genuinely wants free delivery sets the regional RATES to
  // 0; the threshold is only meaningful above zero.
  const rawThreshold = usableRate(data.freeShippingThreshold);
  const freeShippingThreshold = rawThreshold !== null && rawThreshold > 0 ? rawThreshold : null;

  return {
    deliveryEnabled: data.deliveryEnabled === true,
    pickupEnabled: data.pickupEnabled !== false, // absent defaults to enabled, matching Phase 5C
    pickupFee: pickupFee === null ? 0 : pickupFee,
    freeShippingThreshold,
    rates,
    ratesSource,
    // Preserved and surfaced, never deleted — the Admin UI shows this as
    // read-only legacy context so the Owner can see what production held.
    legacyFlatRateDelivery: legacyFlat,
  };
}

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Canonical method entry for the new-shape `gcash` object. */
function gcashMethod(g) {
  const number = cleanText(g.mobileNumber) || cleanText(g.accountNumber);
  return {
    id: 'gcash',
    label: 'GCash',
    enabled: g.enabled === true,
    accountName: cleanText(g.accountName),
    accountNumber: number,
    mobileNumber: number,
    bankName: null,
    instructions: cleanText(g.instructions),
    qrImagePath: cleanText(g.qrImagePath),
  };
}

/** Canonical method entry for the new-shape `bank` object. */
function bankMethod(b) {
  const bankName = cleanText(b.bankName);
  return {
    id: 'bank_transfer',
    label: bankName ? 'Bank Transfer — ' + bankName : 'Bank Transfer',
    enabled: b.enabled === true,
    accountName: cleanText(b.accountName),
    accountNumber: cleanText(b.accountNumber),
    mobileNumber: null,
    bankName,
    instructions: cleanText(b.instructions),
    qrImagePath: cleanText(b.qrImagePath),
  };
}

/** Normalizes a legacy `methods[]` entry into the same canonical shape. */
function legacyMethod(m) {
  return {
    id: m.id,
    label: cleanText(m.label) || m.id,
    enabled: m.enabled === true,
    accountName: cleanText(m.accountName),
    accountNumber: cleanText(m.accountNumber),
    mobileNumber: cleanText(m.mobileNumber),
    bankName: cleanText(m.bankName),
    instructions: cleanText(m.instructions),
    qrImagePath: cleanText(m.qrImagePath),
  };
}

/**
 * Normalizes either settings/payment shape into one canonical object with a
 * merged `methods[]`. Legacy entries are preserved; new-shape gcash/bank
 * overlay the matching id when those objects exist on the doc.
 */
function normalizePaymentSettings(raw) {
  const data = raw || {};

  const merged = new Map();
  for (const m of Array.isArray(data.methods) ? data.methods : []) {
    if (m && typeof m === 'object' && typeof m.id === 'string' && m.id) merged.set(m.id, legacyMethod(m));
  }
  if (data.gcash && typeof data.gcash === 'object') merged.set('gcash', gcashMethod(data.gcash));
  if (data.bank && typeof data.bank === 'object') merged.set('bank_transfer', bankMethod(data.bank));

  return {
    // Fails closed: anything other than an explicit boolean true is false.
    checkoutEnabled: data.checkoutEnabled === true,
    gcash: data.gcash && typeof data.gcash === 'object' ? data.gcash : null,
    bank: data.bank && typeof data.bank === 'object' ? data.bank : null,
    legacyMethods: Array.isArray(data.methods) ? data.methods : [],
    hasNewShape: !!(data.gcash || data.bank || data.checkoutEnabled !== undefined),
    methods: [...merged.values()],
  };
}

async function getShippingSettings(db) {
  const snap = await (db || getDb()).collection('settings').doc('shipping').get();
  return normalizeShippingSettings(snap.exists ? snap.data() : null);
}

async function getPaymentSettings(db) {
  const snap = await (db || getDb()).collection('settings').doc('payment').get();
  return normalizePaymentSettings(snap.exists ? snap.data() : null);
}

/**
 * Only the fields a customer-facing page may ever see — never
 * enabled/internal flags, never a raw Storage path. The QR is resolved to a
 * display URL here, server-side, exactly like every other image in this
 * project (see _shared/publicUrl.js): Firestore stores the object path, the
 * URL is derived on read in one place.
 */
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
      qrImageUrl: m.qrImagePath ? publicUrl(m.qrImagePath) : null,
    }));
}

module.exports = {
  DESTINATION_REGIONS,
  REGION_LABELS,
  DEFAULT_SHIPPING,
  DEFAULT_PAYMENT,
  normalizeShippingSettings,
  normalizePaymentSettings,
  getShippingSettings,
  getPaymentSettings,
  sanitizePaymentMethodsForCustomer,
};
