/*
 * OFFLINE SERVER-SECURITY TEST — no Firebase credentials, no network.
 *
 * Verifies the Phase 5D.2 server-authority guarantees that a browser must
 * never be able to influence. Two kinds of check:
 *
 *   A. STATIC — reads the actual source of the endpoints and asserts they
 *      never read a money/authorization value out of the request body.
 *      A regression here (someone "helpfully" trusting body.shippingFee)
 *      would be caught by these, not by a code review alone.
 *
 *   B. BEHAVIORAL — runs the real rate provider and the real permission
 *      wiring against tampered/hostile inputs.
 *
 * Usage: node scripts/test-server-authority.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'buddy-shop-45fc4.firebasestorage.app';

const { normalizeShippingSettings, normalizePaymentSettings } = require('../netlify/functions/_shared/settings');
const { resolveShippingQuote, validateDestination } = require('../netlify/functions/_shared/shippingRates');
const { ValidationError } = require('../netlify/functions/_shared/validation');

const FN = (name) => fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', name), 'utf8');

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
    throw new Error('threw ' + err.name + ' instead of ValidationError');
  }
  throw new Error('expected a ValidationError, nothing thrown');
}

/* =====================================================================
   A. STATIC SOURCE CHECKS — money never comes from the request
   ===================================================================== */

console.log('\n=== Static: create-order.js must never trust client money ===');

const createOrder = FN('create-order.js');

// Strip comments so prose mentioning these names can't create a false
// positive or mask a real one.
const createOrderCode = createOrder.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

for (const forbidden of [
  'body.shippingFee',
  'body.total',
  'body.subtotal',
  'body.pricing',
  'body.grandTotal',
  'body.amount',
  'body.checkoutEnabled',
  'body.rates',
]) {
  test(`create-order.js never reads ${forbidden}`, () => {
    assert.ok(!createOrderCode.includes(forbidden), `found "${forbidden}" in create-order.js — the browser must not supply this`);
  });
}

test('create-order.js derives shippingFee from resolveShippingQuote, not the request', () => {
  assert.ok(createOrderCode.includes('resolveShippingQuote('), 'must call the rate provider');
  assert.ok(/const shippingFee = quote\.shippingFee/.test(createOrderCode), 'shippingFee must come from the quote');
  assert.ok(/const total = subtotal \+ shippingFee/.test(createOrderCode), 'total must be computed server-side');
});

test('create-order.js enforces the checkoutEnabled master switch', () => {
  assert.ok(createOrderCode.includes('paymentSettings.checkoutEnabled'), 'must read the master switch');
  assert.ok(/if \(!paymentSettings\.checkoutEnabled\)/.test(createOrderCode), 'must refuse when it is off');
  assert.ok(createOrderCode.includes('CHECKOUT_DISABLED'), 'must return a clear error code');
});

test('create-order.js validates the destination through the shared validator', () => {
  assert.ok(createOrderCode.includes('validateDestination('), 'must use validateDestination');
});

test('create-order.js stores destinationRegion + courier/trackingNumber on the snapshot', () => {
  assert.ok(createOrderCode.includes('destinationRegion,'), 'region must be snapshotted');
  assert.ok(createOrderCode.includes('courier: null'), 'courier must be initialized');
  assert.ok(createOrderCode.includes('trackingNumber: null'), 'trackingNumber must be initialized');
});

console.log('\n=== Static: permission split on settings endpoints ===');

test('admin-save-payment-settings.js is OWNER-only', () => {
  const src = FN('admin-save-payment-settings.js');
  assert.ok(src.includes('requireOwner'), 'must import/call requireOwner');
  assert.ok(!/await requireAdmin\(/.test(src), 'must not authorize with requireAdmin');
});

test('admin-save-shipping-settings.js allows Owner AND Admin', () => {
  const src = FN('admin-save-shipping-settings.js');
  assert.ok(src.includes('requireAdmin'), 'must call requireAdmin');
  assert.ok(!src.includes('requireOwner'), 'must not be owner-gated');
});

test('admin-save-payment-settings.js never writes qrImagePath (owned by the upload pipeline)', () => {
  const src = FN('admin-save-payment-settings.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/qrImagePath\s*[:=]/.test(src), 'save endpoint must not set qrImagePath');
});

test('admin-save-payment-settings.js never deletes legacy methods[]', () => {
  const src = FN('admin-save-payment-settings.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/methods\s*:/.test(src), 'must not write the methods array at all');
  assert.ok(src.includes('{ merge: true }'), 'must write with merge:true');
});

test('admin-save-shipping-settings.js never deletes legacy flatRateDelivery', () => {
  const src = FN('admin-save-shipping-settings.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/flatRateDelivery\s*[:=]/.test(src), 'must not write or clear flatRateDelivery');
  assert.ok(src.includes('{ merge: true }'), 'must write with merge:true');
});

console.log('\n=== Static: legacy payment config is carried forward, not blanked ===');

test('admin-get-settings.js prefills gcash/bank from the merged legacy methods', () => {
  const src = FN('admin-get-settings.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Without a fallback, a legacy store would open Settings showing the
  // method OFF, and saving would silently disable a working payment method.
  assert.ok(/methodConfig\(payment\.gcash,\s*payment\.methods\.find/.test(src), 'gcash must fall back to the merged legacy method');
  assert.ok(/methodConfig\(payment\.bank,\s*payment\.methods\.find/.test(src), 'bank must fall back to the merged legacy method');
  assert.ok(src.includes('fromLegacy'), 'the UI must be able to tell the Owner this came from the old format');
});

test('admin-get-settings.js never leaks who edited settings', () => {
  const src = FN('admin-get-settings.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!src.includes('updatedBy'), 'admin view need not echo updatedBy');
});

console.log('\n=== Static: fulfillment courier/tracking rules ===');

const fulfillment = FN('admin-update-fulfillment.js');
const fulfillmentCode = fulfillment.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('courier is REQUIRED only for the shipped transition', () => {
  assert.ok(/targetStatus === 'shipped'/.test(fulfillmentCode));
  assert.ok(/requireString\(body\.courier/.test(fulfillmentCode), 'courier must be required');
  assert.ok(/optionalString\(body\.trackingNumber/.test(fulfillmentCode), 'tracking must be optional');
});

test('courier/tracking are only written on the shipped transition (never erased later)', () => {
  assert.ok(/shippingPatch = targetStatus === 'shipped'/.test(fulfillmentCode),
    'the patch must be conditional so completing an order cannot clear them');
});

test('pickup orders can never be marked shipped', () => {
  assert.ok(/"shipped" only applies to delivery orders/.test(fulfillment));
  assert.ok(/order\.deliveryMethod !== 'delivery'/.test(fulfillmentCode), 'must check the order own delivery method');
});

test('ready_for_pickup is refused for delivery orders', () => {
  assert.ok(/"ready_for_pickup" only applies to pickup orders/.test(fulfillment));
  assert.ok(/order\.deliveryMethod !== 'pickup'/.test(fulfillmentCode));
});

test('fulfillment still cannot start before payment is paid', () => {
  assert.ok(/order\.paymentStatus !== 'paid'/.test(fulfillmentCode));
  assert.ok(/Fulfillment cannot begin until payment is approved/.test(fulfillment));
});

console.log('\n=== Static: Phase 5D engines left intact ===');

test('approve still consumes the reservation (inventory deduction untouched)', () => {
  const src = FN('admin-approve-payment.js');
  assert.ok(src.includes('consumeReservation('), 'must still call consumeReservation');
  assert.ok(src.includes("paymentStatus: 'paid'"));
  assert.ok(src.includes("order.paymentStatus !== 'pending_review'"), 'must still guard the source state');
});

test('reject still reactivates the reservation with a fresh TTL', () => {
  const src = FN('admin-reject-payment.js');
  assert.ok(src.includes('reactivateReservation('), 'must still call reactivateReservation');
  assert.ok(src.includes('REJECTION_CODES'), 'must still require a reason');
});

test('submit-payment still locks the reservation and appends to paymentAttempts', () => {
  const src = FN('submit-payment.js');
  assert.ok(src.includes('lockReservation('), 'must still lock');
  assert.ok(src.includes('expireReservationIfDue('), 'must still lazily expire');
  assert.ok(src.includes('arrayUnion(newAttempt)'), 'must still append, never overwrite, attempts');
});

test('submit-payment is NOT blocked by the checkout master switch', () => {
  // Deliberate: an order that already exists must stay payable even if the
  // Owner switches checkout off, so nobody is stranded mid-payment.
  const src = FN('submit-payment.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!src.includes('checkoutEnabled'), 'submit-payment must not gate on checkoutEnabled');
});

console.log('\n=== Static: customer endpoints leak nothing internal ===');

test('public-settings.js exposes rates + checkoutEnabled, never admin metadata', () => {
  const src = FN('public-settings.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(src.includes('sanitizePaymentMethodsForCustomer'), 'must sanitize methods');
  assert.ok(!src.includes('qrImagePath'), 'must never expose a raw Storage path');
  assert.ok(!src.includes('legacyMethods'), 'must not expose internal legacy bookkeeping');
  assert.ok(!src.includes('updatedBy'), 'must not expose who edited settings');
});

test('get-order.js returns the frozen pricing snapshot verbatim', () => {
  const src = FN('get-order.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/pricing: order\.pricing/.test(src), 'must return the stored snapshot, not a recomputation');
  assert.ok(!src.includes('resolveShippingQuote'), 'must never re-price a historical order');
  assert.ok(!src.includes('accessTokenHash:'), 'must never return the token hash');
});

test('admin-get-order.js never recomputes historical pricing', () => {
  const src = FN('admin-get-order.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/pricing: order\.pricing/.test(src));
  assert.ok(!src.includes('resolveShippingQuote'), 'admin must display, never recalculate');
  assert.ok(!src.includes('getShippingSettings'), 'admin order detail must not consult current rates');
});

console.log('\n=== Static: no historical-order backfill anywhere ===');

for (const file of ['migrate-settings-5d2.js', 'inspect-settings-schema.js', 'verify-phase5d2-predeploy.js']) {
  test(`scripts/${file} never writes to the orders collection`, () => {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    // Any write API applied after a collection('orders') reference.
    assert.ok(!/collection\('orders'\)[\s\S]{0,400}?\.(set|update|delete)\(/.test(src),
      'found a potential write against orders');
  });
}

test('migrate-settings-5d2.js can never enable checkout', () => {
  const src = fs.readFileSync(path.join(__dirname, 'migrate-settings-5d2.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/checkoutEnabled\s*[:=]\s*true/.test(src), 'migration must never write checkoutEnabled:true');
  assert.ok(/checkoutEnabled\s*=\s*false|checkoutEnabled:\s*false/.test(src), 'migration must write it as false');
});

/* =====================================================================
   B. BEHAVIORAL — tampered input cannot change the charge
   ===================================================================== */

console.log('\n=== Behavioral: tampering cannot change the authoritative fee ===');

const LIVE = normalizeShippingSettings({
  deliveryEnabled: true,
  pickupEnabled: true,
  pickupFee: 0,
  freeShippingThreshold: null,
  rates: { luzon: 150, visayas: 180, mindanao: 200 },
});

test('a forged shippingFee in the request is structurally impossible to use', () => {
  // resolveShippingQuote's signature accepts no client fee at all — the only
  // inputs are the validated method/region, the server subtotal, and the
  // server settings. This asserts the contract itself.
  const quote = resolveShippingQuote({
    deliveryMethod: 'delivery',
    destinationRegion: 'mindanao',
    itemSubtotal: 950,
    shipping: LIVE,
    // Anything extra passed here is simply not read.
    shippingFee: 0,
    total: 1,
  });
  assert.strictEqual(quote.shippingFee, 200, 'must use the configured Mindanao rate, not the injected 0');
});

test('a forged cheaper region is still priced at that region real rate', () => {
  const { destinationRegion } = validateDestination('delivery', 'luzon');
  assert.strictEqual(resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion, itemSubtotal: 950, shipping: LIVE }).shippingFee, 150);
});

test('an unknown/injected region is rejected outright', () => {
  throwsValidation(() => validateDestination('delivery', 'free'));
  throwsValidation(() => validateDestination('delivery', 'luzon2'));
  throwsValidation(() => validateDestination('delivery', 'luzon; drop'));
});

test('a non-string region is rejected on TYPE, never coerced into a match', () => {
  // A value that would pass if the validator did String(x) before checking.
  throwsValidation(() => validateDestination('delivery', { toString: () => 'luzon' }));
  throwsValidation(() => validateDestination('delivery', ['luzon']));
  throwsValidation(() => validateDestination('delivery', 0));
  throwsValidation(() => validateDestination('delivery', true));
});

test('surrounding whitespace is tolerated but the enum still binds', () => {
  assert.strictEqual(validateDestination('delivery', '  Visayas  ').destinationRegion, 'visayas');
  throwsValidation(() => validateDestination('delivery', '  vis ayas '));
});

test('omitting the region on a delivery order is rejected, not defaulted', () => {
  throwsValidation(() => validateDestination('delivery', undefined));
});

test('a region smuggled onto a pickup order cannot make shipping non-zero', () => {
  const { deliveryMethod, destinationRegion } = validateDestination('pickup', 'mindanao');
  const quote = resolveShippingQuote({ deliveryMethod, destinationRegion, itemSubtotal: 950, shipping: LIVE });
  assert.strictEqual(destinationRegion, null);
  assert.strictEqual(quote.shippingFee, 0);
});

test('grand total is always subtotal + authoritative fee', () => {
  for (const [region, fee] of [['luzon', 150], ['visayas', 180], ['mindanao', 200]]) {
    const subtotal = 950;
    const quote = resolveShippingQuote({ deliveryMethod: 'delivery', destinationRegion: region, itemSubtotal: subtotal, shipping: LIVE });
    assert.strictEqual(subtotal + quote.shippingFee, 950 + fee);
  }
});

console.log('\n=== Behavioral: master switch fails closed ===');

test('checkoutEnabled is false for every shape that is not literal true', () => {
  const shapes = [null, {}, { methods: [] }, { checkoutEnabled: 'true' }, { checkoutEnabled: 1 }, { gcash: { enabled: true } }];
  for (const s of shapes) {
    assert.strictEqual(normalizePaymentSettings(s).checkoutEnabled, false, JSON.stringify(s));
  }
});

test('configuring payment details does NOT enable checkout', () => {
  const p = normalizePaymentSettings({
    gcash: { enabled: true, accountName: 'Buddy', mobileNumber: '09171234567' },
    bank: { enabled: true, bankName: 'BPI', accountName: 'Buddy', accountNumber: '1234' },
  });
  assert.strictEqual(p.checkoutEnabled, false, 'filling in accounts must never imply going live');
  assert.strictEqual(p.methods.filter((m) => m.enabled).length, 2, 'but the methods themselves are enabled');
});

console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES ABOVE' : ' — all green') + '\n');
