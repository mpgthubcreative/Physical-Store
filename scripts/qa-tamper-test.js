/*
 * PHASE 5D.2 QA — Step 7: server-authority / tampering tests.
 *
 * Runs against the DEPLOYED site over plain HTTP. Needs no Firebase
 * credentials — it only calls public endpoints, exactly as a hostile
 * browser would.
 *
 * What it proves:
 *   - A manipulated request cannot lower the shipping fee or the total.
 *   - An invalid or missing destination region is rejected, not defaulted.
 *   - A region smuggled onto a pickup order cannot change the price.
 *   - While checkout is disabled, order creation is refused outright.
 *
 * IMPORTANT: every request this script sends is a real create-order attempt.
 * Run it ONLY against QA fixture products (see qa-seed-fixtures.js) during
 * your QA window. Any order it does manage to create is a real order
 * document and must be marked isTest:true afterwards via
 * scripts/qa-mark-orders-as-test.js — this script prints the order numbers
 * it created so you can hand them straight to that step.
 *
 * Usage:
 *   node scripts/qa-tamper-test.js --url https://YOURSITE.netlify.app \
 *        --product qa-product-pouch --variant qa-teal
 *
 * Add --expect-closed to assert checkout is DISABLED (use before opening
 * the window, and again after Step 16 closes it).
 */
const crypto = require('crypto');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes('--' + name);

const BASE = (arg('url', '') || '').replace(/\/$/, '');
const PRODUCT_ID = arg('product', 'qa-product-pouch');
const VARIANT_ID = arg('variant', 'qa-teal');
const EXPECT_CLOSED = has('expect-closed');

if (!BASE) {
  console.error('Usage: node scripts/qa-tamper-test.js --url https://YOURSITE.netlify.app [--product qa-product-pouch] [--variant qa-teal] [--expect-closed]');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const createdOrders = [];

function ok(label, detail) {
  console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  passed++;
}
function bad(label, detail) {
  console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  failed++;
}

const hex = (n) => crypto.randomBytes(n).toString('hex');

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    /* non-JSON body */
  }
  return { status: res.status, body: json };
}

/** A syntactically valid create-order payload, plus whatever tampering `extra` adds. */
function payload(extra = {}) {
  return {
    idempotencyKey: crypto.randomUUID(),
    orderAccessToken: hex(32),
    customer: { fullName: 'ZZ QA Tamper', email: 'qa+tamper@example.com', mobile: '09170000000' },
    deliveryMethod: 'delivery',
    destinationRegion: 'visayas',
    deliveryAddress: {
      line1: 'ZZ QA Address 1',
      line2: '',
      barangay: 'ZZ QA Barangay',
      city: 'ZZ QA City',
      province: 'Cebu',
      postalCode: '6000',
    },
    orderNotes: 'QA TAMPER TEST',
    items: [{ productId: PRODUCT_ID, variantId: VARIANT_ID, quantity: 1, personalization: null, patches: [] }],
    ...extra,
  };
}

async function fetchOrder(token) {
  const res = await post('/api/get-order', { token });
  return res.status === 200 ? res.body.order : null;
}

async function main() {
  console.log(`\n=== Phase 5D.2 server-authority QA ===`);
  console.log(`target: ${BASE}`);
  console.log(`fixture: ${PRODUCT_ID} / ${VARIANT_ID}\n`);

  /* ---------- public settings ---------- */
  console.log('--- /api/public-settings ---');
  const settingsRes = await fetch(BASE + '/api/public-settings');
  const settings = await settingsRes.json();
  const checkoutEnabled = settings.checkoutEnabled === true;

  console.log(`  checkoutEnabled: ${checkoutEnabled}`);
  console.log(`  rates: ${JSON.stringify(settings.shipping && settings.shipping.rates)}`);
  console.log(`  pickupFee: ${settings.shipping && settings.shipping.pickupFee}`);
  console.log(`  methods: ${(settings.paymentMethods || []).map((m) => m.id).join(', ') || 'none'}`);

  if (settings.paymentMethods) {
    const leaked = settings.paymentMethods.filter((m) => 'qrImagePath' in m || 'enabled' in m);
    if (leaked.length) bad('public settings leak internal fields', JSON.stringify(leaked[0]));
    else ok('public settings expose no qrImagePath / enabled flags');
  }

  if (EXPECT_CLOSED) {
    console.log('\n--- checkout must be CLOSED ---');
    if (!checkoutEnabled) ok('/api/public-settings reports checkoutEnabled:false');
    else bad('/api/public-settings reports checkout LIVE', 'expected disabled');

    const blocked = await post('/api/create-order', payload());
    if (blocked.status === 503 && blocked.body && blocked.body.error === 'CHECKOUT_DISABLED') {
      ok('create-order refuses with 503 CHECKOUT_DISABLED');
    } else {
      bad('create-order was NOT blocked', `status ${blocked.status} ${JSON.stringify(blocked.body)}`);
    }
    return summary();
  }

  if (!checkoutEnabled) {
    console.log('\n  checkout is disabled — order-creating tests skipped.');
    console.log('  Open the QA window first, or run with --expect-closed to assert closure.');
    return summary();
  }

  /* ---------- baseline: what the server says the price is ---------- */
  console.log('\n--- baseline authoritative pricing ---');
  const baseToken = hex(32);
  const baseRes = await post('/api/create-order', payload({ orderAccessToken: baseToken }));
  if (baseRes.status !== 200) {
    bad('baseline order could not be created', `status ${baseRes.status} ${JSON.stringify(baseRes.body)}`);
    return summary();
  }
  createdOrders.push(baseRes.body.orderNumber);
  const baseOrder = await fetchOrder(baseToken);
  if (!baseOrder) {
    bad('baseline order could not be read back');
    return summary();
  }
  const trueSubtotal = baseOrder.pricing.subtotal;
  const trueVisayas = baseOrder.pricing.shippingFee;
  console.log(`  ${baseRes.body.orderNumber}: subtotal ${trueSubtotal}, Visayas shipping ${trueVisayas}, total ${baseOrder.pricing.total}`);
  if (baseOrder.pricing.total === trueSubtotal + trueVisayas) ok('total = subtotal + shippingFee');
  else bad('total does not equal subtotal + shippingFee');

  /* ---------- tampering ---------- */
  console.log('\n--- tampered pricing must be ignored ---');

  const tamperCases = [
    { label: 'forged shippingFee: 0', extra: { shippingFee: 0 } },
    { label: 'forged total: 1', extra: { total: 1 } },
    { label: 'forged subtotal: 1', extra: { subtotal: 1 } },
    { label: 'forged pricing object', extra: { pricing: { subtotal: 1, shippingFee: 0, total: 1 } } },
    { label: 'forged shippingFee + total together', extra: { shippingFee: 0, total: 1, grandTotal: 1 } },
  ];

  for (const tc of tamperCases) {
    const token = hex(32);
    const res = await post('/api/create-order', payload({ orderAccessToken: token, ...tc.extra }));
    if (res.status !== 200) {
      bad(tc.label, `order rejected outright (status ${res.status}) — expected it to be accepted but priced correctly`);
      continue;
    }
    createdOrders.push(res.body.orderNumber);
    const o = await fetchOrder(token);
    if (!o) {
      bad(tc.label, 'could not read order back');
      continue;
    }
    const correct = o.pricing.shippingFee === trueVisayas && o.pricing.subtotal === trueSubtotal && o.pricing.total === trueSubtotal + trueVisayas;
    if (correct) ok(tc.label, `server still charged ${o.pricing.total} (${o.pricing.subtotal}+${o.pricing.shippingFee})`);
    else bad(tc.label, `SERVER ACCEPTED CLIENT PRICING: ${JSON.stringify(o.pricing)}`);
  }

  /* ---------- region validation ---------- */
  console.log('\n--- destination region validation ---');

  const badRegions = [
    { label: 'invalid region "free"', region: 'free' },
    { label: 'invalid region "ncr"', region: 'ncr' },
    { label: 'missing region for delivery (null)', region: null },
    { label: 'missing region for delivery (empty)', region: '' },
  ];
  for (const br of badRegions) {
    const res = await post('/api/create-order', payload({ orderAccessToken: hex(32), destinationRegion: br.region }));
    if (res.status === 400) ok(br.label, 'rejected 400');
    else {
      if (res.status === 200) createdOrders.push(res.body.orderNumber);
      bad(br.label, `expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
    }
  }

  /* ---------- region on pickup is ignored ---------- */
  console.log('\n--- pickup ignores any supplied region ---');
  const pickupToken = hex(32);
  const pickupRes = await post(
    '/api/create-order',
    payload({
      orderAccessToken: pickupToken,
      deliveryMethod: 'pickup',
      destinationRegion: 'mindanao', // most expensive region, smuggled onto a pickup
      deliveryAddress: null,
    })
  );
  if (pickupRes.status === 200) {
    createdOrders.push(pickupRes.body.orderNumber);
    const o = await fetchOrder(pickupToken);
    if (o && o.pricing.shippingFee === 0 && o.destinationRegion === null) {
      ok('pickup priced ₱0 and destinationRegion stored as null');
    } else {
      bad('pickup order mispriced or kept a region', JSON.stringify({ fee: o && o.pricing.shippingFee, region: o && o.destinationRegion }));
    }
  } else {
    bad('pickup order could not be created', `status ${pickupRes.status} ${JSON.stringify(pickupRes.body)}`);
  }

  /* ---------- each region prices correctly ---------- */
  console.log('\n--- regional rates ---');
  const expected = settings.shipping.rates;
  for (const region of ['luzon', 'visayas', 'mindanao']) {
    const token = hex(32);
    const res = await post('/api/create-order', payload({ orderAccessToken: token, destinationRegion: region }));
    if (res.status !== 200) {
      bad(`${region} order`, `status ${res.status} ${JSON.stringify(res.body)}`);
      continue;
    }
    createdOrders.push(res.body.orderNumber);
    const o = await fetchOrder(token);
    if (o && o.pricing.shippingFee === Number(expected[region])) {
      ok(`${region} charged ₱${o.pricing.shippingFee}`, `total ₱${o.pricing.total}`);
    } else {
      bad(`${region} shipping fee`, `expected ${expected[region]}, got ${o && o.pricing.shippingFee}`);
    }
  }

  summary();
}

function summary() {
  console.log('\n=== Summary ===');
  console.log(`  ${passed} passed, ${failed} failed`);
  if (createdOrders.length) {
    console.log(`\n  ORDERS CREATED BY THIS RUN (${createdOrders.length}) — mark these isTest:true:`);
    console.log('  ' + createdOrders.join(' '));
    console.log('\n  node scripts/qa-mark-orders-as-test.js --apply --orders ' + createdOrders.join(','));
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Tamper test failed to run:', err);
  process.exit(1);
});
