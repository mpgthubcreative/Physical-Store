/*
 * OFFLINE UNIT TEST — no Firebase credentials, no network, no Firestore.
 * Exercises the Phase 5D.2 dual-shape settings normalizers and the
 * shipping rate provider against every shape production could hold:
 * legacy-only, new-only, mixed, empty, and hostile/tampered input.
 *
 * Usage: node scripts/test-settings-normalization.js
 */
const assert = require('assert');

process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'buddy-shop-45fc4.firebasestorage.app';

const {
  normalizeShippingSettings,
  normalizePaymentSettings,
  sanitizePaymentMethodsForCustomer,
} = require('../netlify/functions/_shared/settings');
const { validateDestination, resolveShippingQuote } = require('../netlify/functions/_shared/shippingRates');
const { ValidationError } = require('../netlify/functions/_shared/validation');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    console.error('  FAIL  ' + name + '\n        ' + err.message);
    process.exitCode = 1;
  }
}
function throwsValidation(fn) {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return;
    throw new Error('threw the wrong error type: ' + err.name);
  }
  throw new Error('expected a ValidationError, but nothing was thrown');
}

console.log('\n=== settings/shipping normalization (dual shape) ===');

test('empty doc -> unconfigured, delivery off, pickup on, pickupFee 0', () => {
  const s = normalizeShippingSettings(null);
  assert.strictEqual(s.ratesSource, 'unconfigured');
  assert.strictEqual(s.deliveryEnabled, false);
  assert.strictEqual(s.pickupEnabled, true);
  assert.strictEqual(s.pickupFee, 0);
  assert.strictEqual(s.freeShippingThreshold, null);
  assert.deepStrictEqual(s.rates, { luzon: null, visayas: null, mindanao: null });
});

test('LEGACY shape (flatRateDelivery: 80) -> all three regions priced 80, source legacy-flat', () => {
  const s = normalizeShippingSettings({ deliveryEnabled: true, flatRateDelivery: 80, pickupEnabled: true, pickupFee: 0 });
  assert.strictEqual(s.ratesSource, 'legacy-flat');
  assert.deepStrictEqual(s.rates, { luzon: 80, visayas: 80, mindanao: 80 });
  assert.strictEqual(s.legacyFlatRateDelivery, 80, 'legacy value must be preserved, never discarded');
});

test('NEW shape (rates) wins over legacy flatRateDelivery, legacy still preserved', () => {
  const s = normalizeShippingSettings({
    deliveryEnabled: true,
    flatRateDelivery: 80,
    rates: { luzon: 150, visayas: 180, mindanao: 200 },
  });
  assert.strictEqual(s.ratesSource, 'regional');
  assert.deepStrictEqual(s.rates, { luzon: 150, visayas: 180, mindanao: 200 });
  assert.strictEqual(s.legacyFlatRateDelivery, 80, 'legacy field must survive normalization');
});

test('PARTIAL rates fall back to legacy flat only for the missing regions', () => {
  const s = normalizeShippingSettings({ deliveryEnabled: true, flatRateDelivery: 80, rates: { luzon: 150 } });
  assert.strictEqual(s.ratesSource, 'partial');
  assert.deepStrictEqual(s.rates, { luzon: 150, visayas: 80, mindanao: 80 });
});

test('PARTIAL rates with no legacy flat leave gaps null (never free, never guessed)', () => {
  const s = normalizeShippingSettings({ deliveryEnabled: true, rates: { luzon: 150 } });
  assert.deepStrictEqual(s.rates, { luzon: 150, visayas: null, mindanao: null });
});

test('garbage/negative rate values read as unconfigured, not as 0', () => {
  const s = normalizeShippingSettings({ rates: { luzon: 'free', visayas: -50, mindanao: null } });
  assert.deepStrictEqual(s.rates, { luzon: null, visayas: null, mindanao: null });
  assert.strictEqual(s.ratesSource, 'unconfigured');
});

test('pickupEnabled absent defaults true; explicit false respected', () => {
  assert.strictEqual(normalizeShippingSettings({}).pickupEnabled, true);
  assert.strictEqual(normalizeShippingSettings({ pickupEnabled: false }).pickupEnabled, false);
});

console.log('\n=== settings/payment normalization (dual shape) ===');

test('empty doc -> checkoutEnabled FALSE and zero methods', () => {
  const p = normalizePaymentSettings(null);
  assert.strictEqual(p.checkoutEnabled, false);
  assert.deepStrictEqual(p.methods, []);
});

test('checkoutEnabled fails closed for every non-true value', () => {
  for (const v of [undefined, null, false, 'true', 1, {}, 'yes']) {
    assert.strictEqual(normalizePaymentSettings({ checkoutEnabled: v }).checkoutEnabled, false, 'value: ' + JSON.stringify(v));
  }
  assert.strictEqual(normalizePaymentSettings({ checkoutEnabled: true }).checkoutEnabled, true);
});

test('LEGACY methods[] pass through and stay usable', () => {
  const p = normalizePaymentSettings({
    methods: [{ id: 'gcash', label: 'GCash', enabled: true, accountName: 'Buddy', accountNumber: '09171234567' }],
  });
  assert.strictEqual(p.methods.length, 1);
  assert.strictEqual(p.methods[0].id, 'gcash');
  assert.strictEqual(p.methods[0].enabled, true);
  assert.strictEqual(p.methods[0].accountName, 'Buddy');
});

test('NEW gcash/bank objects OVERLAY the matching legacy ids', () => {
  const p = normalizePaymentSettings({
    methods: [{ id: 'gcash', label: 'Old GCash', enabled: true, accountName: 'Stale' }],
    gcash: { enabled: false, accountName: 'Fresh', mobileNumber: '09990001111' },
  });
  const gcash = p.methods.find((m) => m.id === 'gcash');
  assert.strictEqual(p.methods.length, 1, 'overlay must replace, not duplicate, the id');
  assert.strictEqual(gcash.enabled, false, 'new shape is authoritative once written');
  assert.strictEqual(gcash.accountName, 'Fresh');
});

test('an UNRELATED legacy method is never dropped by the new shape', () => {
  const p = normalizePaymentSettings({
    methods: [{ id: 'maya', label: 'Maya', enabled: true, accountNumber: '0917' }],
    gcash: { enabled: true, accountName: 'Buddy', mobileNumber: '0917' },
  });
  assert.strictEqual(p.methods.length, 2);
  assert.ok(p.methods.find((m) => m.id === 'maya'), 'legacy maya must survive');
});

test('bank_transfer id + label derived from bankName', () => {
  const p = normalizePaymentSettings({ bank: { enabled: true, bankName: 'BPI', accountName: 'Buddy', accountNumber: '1234' } });
  const bank = p.methods.find((m) => m.id === 'bank_transfer');
  assert.ok(bank, 'bank object must map to canonical id bank_transfer');
  assert.strictEqual(bank.label, 'Bank Transfer — BPI');
});

console.log('\n=== customer sanitization (no internal metadata leaks) ===');

test('disabled methods never reach the customer', () => {
  const p = normalizePaymentSettings({ gcash: { enabled: false, accountName: 'X' }, bank: { enabled: true, bankName: 'BPI' } });
  const out = sanitizePaymentMethodsForCustomer(p);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'bank_transfer');
});

test('sanitized output exposes qrImageUrl but never qrImagePath/enabled', () => {
  const p = normalizePaymentSettings({ gcash: { enabled: true, accountName: 'Buddy', qrImagePath: 'settings-images/payment/gcashQr-1-x.png' } });
  const out = sanitizePaymentMethodsForCustomer(p)[0];
  assert.ok(out.qrImageUrl && out.qrImageUrl.startsWith('https://firebasestorage.googleapis.com/'), 'QR must be a resolved URL');
  assert.strictEqual(out.qrImagePath, undefined, 'raw Storage path must never leak to a customer');
  assert.strictEqual(out.enabled, undefined, 'internal enabled flag must not leak');
  assert.deepStrictEqual(Object.keys(out).sort(), ['accountName', 'accountNumber', 'bankName', 'id', 'instructions', 'label', 'qrImageUrl'].sort());
});

test('no QR configured -> qrImageUrl null (not a broken URL)', () => {
  const p = normalizePaymentSettings({ gcash: { enabled: true, accountName: 'Buddy' } });
  assert.strictEqual(sanitizePaymentMethodsForCustomer(p)[0].qrImageUrl, null);
});

console.log('\n=== destination validation ===');

test('delivery requires a valid region', () => {
  assert.deepStrictEqual(validateDestination('delivery', 'visayas'), { deliveryMethod: 'delivery', destinationRegion: 'visayas' });
  throwsValidation(() => validateDestination('delivery', null));
  throwsValidation(() => validateDestination('delivery', ''));
  throwsValidation(() => validateDestination('delivery', 'ncr'));
  throwsValidation(() => validateDestination('delivery', 'LUZON; DROP'));
});

test('region is case-insensitive but still enum-constrained', () => {
  assert.strictEqual(validateDestination('delivery', 'LUZON').destinationRegion, 'luzon');
});

test('pickup forces destinationRegion to null, ignoring any supplied region', () => {
  assert.deepStrictEqual(validateDestination('pickup', 'mindanao'), { deliveryMethod: 'pickup', destinationRegion: null });
  assert.deepStrictEqual(validateDestination('pickup', null), { deliveryMethod: 'pickup', destinationRegion: null });
});

test('an invalid deliveryMethod is rejected', () => {
  throwsValidation(() => validateDestination('teleport', null));
});

console.log('\n=== authoritative shipping quotes (approved V1 defaults) ===');

const V1 = normalizeShippingSettings({
  deliveryEnabled: true,
  pickupEnabled: true,
  pickupFee: 0,
  freeShippingThreshold: null,
  rates: { luzon: 150, visayas: 180, mindanao: 200 },
});

test('Pickup = 0', () => {
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'pickup', destinationRegion: null, itemSubtotal: 950, shipping: V1 }).shippingFee, 0);
});
test('Luzon = 150', () => {
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'luzon', itemSubtotal: 950, shipping: V1 }).shippingFee, 150);
});
test('Visayas = 180', () => {
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'visayas', itemSubtotal: 950, shipping: V1 }).shippingFee, 180);
});
test('Mindanao = 200', () => {
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'mindanao', itemSubtotal: 950, shipping: V1 }).shippingFee, 200);
});

test('worked example from the brief: 950 + Visayas 180 = 1130', () => {
  const subtotal = 950;
  const quote = resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'visayas', itemSubtotal: subtotal, shipping: V1 });
  assert.strictEqual(subtotal + quote.shippingFee, 1130);
});

test('free-shipping threshold is OFF by default (null) — regional rate still charged', () => {
  assert.strictEqual(V1.freeShippingThreshold, null);
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'luzon', itemSubtotal: 999999, shipping: V1 }).shippingFee, 150);
});

test('free shipping applies ONLY at/above a configured threshold, on merchandise subtotal', () => {
  const withThreshold = normalizeShippingSettings({ deliveryEnabled: true, rates: { luzon: 150, visayas: 180, mindanao: 200 }, freeShippingThreshold: 1500 });
  const below = resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'luzon', itemSubtotal: 1499, shipping: withThreshold });
  const at = resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'luzon', itemSubtotal: 1500, shipping: withThreshold });
  assert.strictEqual(below.shippingFee, 150);
  assert.strictEqual(below.freeShippingApplied, false);
  assert.strictEqual(at.shippingFee, 0);
  assert.strictEqual(at.freeShippingApplied, true);
});

test('REGRESSION: a threshold of 0 means DISABLED, not "everything free"', () => {
  // Production hit this: freeShippingThreshold:0 made `subtotal >= 0` true
  // for every order, zeroing out all three regional rates with nothing
  // appearing broken. 0 must normalize to null.
  const zeroed = normalizeShippingSettings({
    deliveryEnabled: true,
    rates: { luzon: 150, visayas: 180, mindanao: 200 },
    freeShippingThreshold: 0,
  });
  assert.strictEqual(zeroed.freeShippingThreshold, null, '0 must normalize to null (disabled)');
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'luzon', itemSubtotal: 950, shipping: zeroed }).shippingFee, 150);
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'visayas', itemSubtotal: 950, shipping: zeroed }).shippingFee, 180);
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'mindanao', itemSubtotal: 950, shipping: zeroed }).shippingFee, 200);
});

test('REGRESSION: even a raw 0 threshold passed straight to the quote is ignored', () => {
  // Defence in depth — a caller bypassing the normalizer must not be able
  // to reintroduce the bug.
  const raw = { deliveryEnabled: true, pickupEnabled: true, pickupFee: 0, rates: { luzon: 150, visayas: 180, mindanao: 200 }, freeShippingThreshold: 0 };
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'luzon', itemSubtotal: 950, shipping: raw }).shippingFee, 150);
});

test('a negative threshold is also treated as disabled', () => {
  const neg = normalizeShippingSettings({ deliveryEnabled: true, rates: { luzon: 150, visayas: 180, mindanao: 200 }, freeShippingThreshold: -100 });
  assert.strictEqual(neg.freeShippingThreshold, null);
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'luzon', itemSubtotal: 950, shipping: neg }).shippingFee, 150);
});

test('free shipping never applies to pickup', () => {
  const withThreshold = normalizeShippingSettings({ pickupEnabled: true, pickupFee: 50, freeShippingThreshold: 1 });
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'pickup', destinationRegion: null, itemSubtotal: 9999, shipping: withThreshold }).shippingFee, 50);
});

test('delivery refused when deliveryEnabled is false', () => {
  const off = normalizeShippingSettings({ deliveryEnabled: false, rates: { luzon: 150, visayas: 180, mindanao: 200 } });
  throwsValidation(() => resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'luzon', itemSubtotal: 100, shipping: off }));
});

test('delivery refused for a region with no configured rate', () => {
  const partial = normalizeShippingSettings({ deliveryEnabled: true, rates: { luzon: 150 } });
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'luzon', itemSubtotal: 100, shipping: partial }).shippingFee, 150);
  throwsValidation(() => resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: 'mindanao', itemSubtotal: 100, shipping: partial }));
});

test('pickup refused when pickupEnabled is false', () => {
  const off = normalizeShippingSettings({ pickupEnabled: false });
  throwsValidation(() => resolveShippingQuote({ deliveryMethod: 'pickup', destinationRegion: null, itemSubtotal: 100, shipping: off }));
});

test('LEGACY store still quotes correctly (flat 80 everywhere)', () => {
  const legacy = normalizeShippingSettings({ deliveryEnabled: true, flatRateDelivery: 80 });
  for (const region of ['luzon', 'visayas', 'mindanao']) {
    assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: region, itemSubtotal: 500, shipping: legacy }).shippingFee, 80);
  }
});

console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES ABOVE' : ' — all green') + '\n');
