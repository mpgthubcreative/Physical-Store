/*
 * ONE-TIME / RE-RUNNABLE LOCAL SCRIPT — strictly READ-ONLY Phase 5D.2
 * pre-deployment verification. Performs no .set()/.update()/.delete()/
 * transaction and no Storage mutation — every call here is a .get().
 *
 * Same spirit as scripts/verify-phase5d-predeploy.js. Confirms, against
 * real production data, that:
 *
 *   1. checkoutEnabled is FALSE (production stays non-purchasable).
 *   2. No payment method is enabled until the Owner configures one.
 *   3. Shipping settings resolve to a usable, explicit shape.
 *   4. Existing orders still render — i.e. every order the Admin UI would
 *      load has the fields the new UI reads, or safely absent ones that
 *      render as "Not recorded". Specifically checks that no order is
 *      missing its pricing snapshot, and reports how many predate the new
 *      destinationRegion/courier fields.
 *   5. Historical pricing is untouched: prints each order's stored
 *      subtotal/shippingFee/total so they can be compared before and after
 *      deploy. This script never writes them.
 *
 * Never prints the service-account JSON, a private key, an ID token, or a
 * customer's raw order-access token.
 *
 * Usage: node scripts/verify-phase5d2-predeploy.js
 * Credentials: FIREBASE_SERVICE_ACCOUNT_JSON in your shell, or a local
 * serviceAccountKey.json (gitignored).
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'buddy-shop-45fc4.firebasestorage.app';
const { normalizeShippingSettings, normalizePaymentSettings } = require('../netlify/functions/_shared/settings');

const EXPECTED_PROJECT = 'buddy-shop-45fc4';
const ORDER_SAMPLE_LIMIT = 200;

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const localKeyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(localKeyPath)) return JSON.parse(fs.readFileSync(localKeyPath, 'utf8'));
  console.error('No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON or add serviceAccountKey.json.');
  process.exit(1);
}

let failures = 0;
let warnings = 0;
function check(label, pass, detail) {
  console.log(`  ${pass ? 'OK  ' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!pass) failures++;
}
function warn(label, detail) {
  console.log(`  WARN  ${label}${detail ? ' — ' + detail : ''}`);
  warnings++;
}

async function main() {
  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  console.log('=== Firebase project check ===');
  console.log(`project_id: ${serviceAccount.project_id}`);
  if (serviceAccount.project_id !== EXPECTED_PROJECT) {
    console.error(`Refusing to continue: expected "${EXPECTED_PROJECT}".`);
    process.exit(1);
  }

  /* ---------- 1 + 2: production safety ---------- */
  console.log('\n=== Production safety (checkout must stay OFF) ===');
  const paySnap = await db.collection('settings').doc('payment').get();
  const pay = normalizePaymentSettings(paySnap.exists ? paySnap.data() : null);

  check('settings/payment.checkoutEnabled is FALSE', pay.checkoutEnabled === false,
    pay.checkoutEnabled ? 'STORE IS LIVE — this must be false until you approve activation' : 'store cannot take orders');

  const enabledMethods = pay.methods.filter((m) => m.enabled);
  check('no payment method is enabled yet', enabledMethods.length === 0,
    enabledMethods.length ? 'enabled: ' + enabledMethods.map((m) => m.id).join(', ') : 'none enabled');

  console.log(`  info  legacy methods[] entries preserved: ${pay.legacyMethods.length}`);
  console.log(`  info  merged methods visible to the app: ${pay.methods.length}`);

  /* ---------- 3: shipping ---------- */
  console.log('\n=== Shipping configuration ===');
  const shipSnap = await db.collection('settings').doc('shipping').get();
  const ship = normalizeShippingSettings(shipSnap.exists ? shipSnap.data() : null);

  console.log(`  info  ratesSource: ${ship.ratesSource}`);
  console.log(`  info  rates: luzon=${ship.rates.luzon} visayas=${ship.rates.visayas} mindanao=${ship.rates.mindanao} pickup=${ship.pickupFee}`);
  console.log(`  info  legacyFlatRateDelivery preserved: ${ship.legacyFlatRateDelivery}`);
  console.log(`  info  freeShippingThreshold: ${ship.freeShippingThreshold}${ship.freeShippingThreshold === null ? ' (disabled, as approved)' : ''}`);

  if (ship.deliveryEnabled) {
    const unpriced = ['luzon', 'visayas', 'mindanao'].filter((r) => ship.rates[r] === null);
    check('delivery is enabled and every region has a rate', unpriced.length === 0,
      unpriced.length ? 'unpriced: ' + unpriced.join(', ') : 'all three priced');
  } else {
    console.log('  info  delivery is currently disabled.');
  }

  /* ---------- 4 + 5: historical orders ---------- */
  console.log('\n=== Historical order compatibility (read-only) ===');
  const ordersSnap = await db.collection('orders').orderBy('createdAt', 'desc').limit(ORDER_SAMPLE_LIMIT).get();
  console.log(`  info  inspected ${ordersSnap.size} most recent order(s) (limit ${ORDER_SAMPLE_LIMIT})`);

  let missingPricing = 0;
  let noRegion = 0;
  let deliveryNoRegion = 0;
  let noBarangay = 0;
  let shippedNoCourier = 0;
  let testOrders = 0;

  const rows = [];
  ordersSnap.forEach((doc) => {
    const o = doc.data();
    if (o.isTest === true) testOrders++;

    const p = o.pricing;
    if (!p || typeof p.total !== 'number' || typeof p.subtotal !== 'number' || typeof p.shippingFee !== 'number') {
      missingPricing++;
      rows.push({ n: o.orderNumber, issue: 'MISSING/INVALID pricing snapshot' });
      return;
    }

    if (!o.destinationRegion) {
      noRegion++;
      if (o.deliveryMethod === 'delivery') deliveryNoRegion++;
    }
    if (o.deliveryMethod === 'delivery' && o.deliveryAddress && !o.deliveryAddress.barangay) noBarangay++;
    if ((o.fulfillmentStatus === 'shipped' || o.fulfillmentStatus === 'completed') && o.deliveryMethod === 'delivery' && !o.courier) shippedNoCourier++;

    rows.push({
      n: o.orderNumber,
      method: o.deliveryMethod,
      region: o.destinationRegion || '(not recorded)',
      subtotal: p.subtotal,
      shipping: p.shippingFee,
      total: p.total,
      sum: p.subtotal + p.shippingFee === p.total,
      isTest: o.isTest === true,
    });
  });

  check('every inspected order has a valid pricing snapshot', missingPricing === 0,
    missingPricing ? `${missingPricing} order(s) missing pricing — the Admin UI would not render these` : 'all present');

  const inconsistent = rows.filter((r) => r.sum === false);
  check('every order total equals subtotal + shippingFee', inconsistent.length === 0,
    inconsistent.length ? 'inconsistent: ' + inconsistent.map((r) => r.n).join(', ') : 'all consistent');

  console.log(`  info  orders with no destinationRegion (pre-5D.2 or pickup): ${noRegion}`);
  console.log(`  info    ...of which are DELIVERY orders -> Admin shows "Not recorded": ${deliveryNoRegion}`);
  console.log(`  info  delivery orders with no barangay recorded: ${noBarangay}`);
  console.log(`  info  shipped/completed delivery orders with no courier -> "Not recorded": ${shippedNoCourier}`);
  console.log(`  info  TEST orders in sample: ${testOrders}`);

  if (deliveryNoRegion > 0 || shippedNoCourier > 0) {
    console.log('\n  These are EXPECTED for orders that predate Phase 5D.2. They are');
    console.log('  rendered as "Not recorded" and are deliberately NOT backfilled.');
  }

  console.log('\n=== Historical pricing snapshot (compare before/after deploy) ===');
  console.log('  order        method    region        subtotal  shipping   total');
  for (const r of rows.slice(0, 40)) {
    if (r.issue) {
      console.log(`  ${String(r.n).padEnd(12)} ${r.issue}`);
      continue;
    }
    console.log(
      `  ${String(r.n).padEnd(12)} ${String(r.method || '?').padEnd(9)} ${String(r.region).padEnd(13)} ` +
        `${String(r.subtotal).padStart(8)} ${String(r.shipping).padStart(9)} ${String(r.total).padStart(7)}` +
        (r.isTest ? '  [TEST]' : '')
    );
  }
  if (rows.length > 40) console.log(`  ... and ${rows.length - 40} more`);

  /* ---------- summary ---------- */
  console.log('\n=== Summary ===');
  if (failures) {
    console.log(`  ${failures} CHECK(S) FAILED — do not deploy until resolved.`);
  } else {
    console.log('  All checks passed.');
  }
  if (warnings) console.log(`  ${warnings} warning(s).`);
  console.log(`  Production checkout state: ${pay.checkoutEnabled ? 'LIVE (!!)' : 'DISABLED (correct for now)'}`);
  console.log('  This script wrote nothing.');

  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
