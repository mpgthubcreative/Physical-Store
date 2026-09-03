/*
 * PHASE 5D.2 QA — Step 17: post-QA cleanup verification. READ-ONLY.
 *
 * Performs no .set()/.update()/.delete()/transaction of any kind — every
 * Firestore call here is a .get(). It answers, with evidence:
 *
 *   1. Is production checkout OFF?
 *   2. Is every order created during the QA window marked isTest:true?
 *   3. Are any QA reservations still ACTIVE or LOCKED (i.e. still holding
 *      stock they should have released)?
 *   4. Were the normal seeded products/patches left unchanged — specifically
 *      is reservedQty back to a sane value and is no non-QA product still
 *      holding a reservation from this pass?
 *   5. Do historical (pre-5D.2) orders still carry their original pricing?
 *
 * Usage:
 *   node scripts/qa-cleanup-verify.js
 *   node scripts/qa-cleanup-verify.js --since 2026-09-03
 *
 * --since limits the "orders created during QA" scan to orders created on or
 * after that date (YYYY-MM-DD). Without it, the 100 most recent orders are
 * inspected.
 *
 * Credentials: FIREBASE_SERVICE_ACCOUNT_JSON, or serviceAccountKey.json.
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const EXPECTED_PROJECT = 'buddy-shop-45fc4';
const RECENT_LIMIT = 100;
const QA_ID_RE = /^qa-/i;
const QA_NAME_RE = /^ZZ QA/i;

process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'buddy-shop-45fc4.firebasestorage.app';
const { normalizePaymentSettings } = require('../netlify/functions/_shared/settings');

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const p = path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  console.error('No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON or add serviceAccountKey.json.');
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
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

function looksLikeQaOrder(o) {
  if (o.isTest === true) return true;
  if (QA_NAME_RE.test(String(o.customerName || ''))) return true;
  if (/(^|[+@])qa[+@.-]|@example\.(com|org|net)$/i.test(String(o.customerEmail || ''))) return true;
  const ids = o.referencedProductIds || [];
  return ids.length > 0 && ids.every((id) => QA_ID_RE.test(id));
}

async function main() {
  const sa = loadServiceAccount();
  if (sa.project_id !== EXPECTED_PROJECT) {
    console.error(`Refusing to run: expected project "${EXPECTED_PROJECT}", got "${sa.project_id}".`);
    process.exit(1);
  }
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  const sinceRaw = arg('since');
  const since = sinceRaw ? new Date(sinceRaw + 'T00:00:00Z') : null;
  if (sinceRaw && Number.isNaN(since.getTime())) {
    console.error('--since must be YYYY-MM-DD');
    process.exit(1);
  }

  console.log('=== Phase 5D.2 post-QA cleanup verification (read-only) ===');
  console.log(`project: ${sa.project_id}`);
  console.log(since ? `scanning orders created since ${sinceRaw}\n` : `scanning the ${RECENT_LIMIT} most recent orders\n`);

  /* ---------- 1. checkout off ---------- */
  console.log('--- 1. Production checkout ---');
  const paySnap = await db.collection('settings').doc('payment').get();
  const pay = normalizePaymentSettings(paySnap.exists ? paySnap.data() : null);
  check('checkoutEnabled is FALSE', pay.checkoutEnabled === false, pay.checkoutEnabled ? 'STORE IS LIVE' : 'store cannot take orders');
  const stillEnabled = pay.methods.filter((m) => m.enabled).map((m) => m.id);
  if (stillEnabled.length) {
    warn('payment methods still enabled', stillEnabled.join(', ') + ' — fine if intentional, but QA-only details should not stay advertised');
  } else {
    console.log('  info  no payment method is enabled.');
  }

  /* ---------- 2. QA orders marked ---------- */
  console.log('\n--- 2. QA orders marked isTest:true ---');
  let q = db.collection('orders').orderBy('createdAt', 'desc');
  if (since) q = db.collection('orders').where('createdAt', '>=', admin.firestore.Timestamp.fromDate(since)).orderBy('createdAt', 'desc');
  const ordersSnap = await q.limit(since ? 500 : RECENT_LIMIT).get();

  const unmarkedQa = [];
  const qaOrders = [];
  const realOrders = [];
  ordersSnap.forEach((doc) => {
    const o = doc.data();
    if (looksLikeQaOrder(o)) {
      qaOrders.push({ id: doc.id, ...o });
      if (o.isTest !== true) unmarkedQa.push(o.orderNumber);
    } else {
      realOrders.push({ id: doc.id, ...o });
    }
  });

  console.log(`  info  inspected ${ordersSnap.size} order(s): ${qaOrders.length} look like QA, ${realOrders.length} do not`);
  check('every QA-looking order is isTest:true', unmarkedQa.length === 0,
    unmarkedQa.length ? 'UNMARKED: ' + unmarkedQa.join(', ') : 'all marked');
  if (unmarkedQa.length) {
    console.log('        fix with: node scripts/qa-mark-orders-as-test.js --apply --orders ' + unmarkedQa.join(','));
  }

  // A real order accidentally marked isTest would hide it from real reporting.
  const wronglyMarked = realOrders.filter((o) => o.isTest === true).map((o) => o.orderNumber);
  check('no non-QA order was marked isTest', wronglyMarked.length === 0,
    wronglyMarked.length ? 'CHECK THESE: ' + wronglyMarked.join(', ') : 'none');

  /* ---------- 3. lingering reservations ---------- */
  console.log('\n--- 3. QA reservations released ---');
  const lingering = [];
  for (const o of qaOrders) {
    const r = await db.collection('inventoryReservations').doc(o.id).get();
    if (!r.exists) continue;
    const res = r.data();
    if (res.status === 'active' || res.status === 'locked') {
      lingering.push(`${o.orderNumber}:${res.status}`);
    }
  }
  check('no QA reservation is still active/locked', lingering.length === 0,
    lingering.length ? lingering.join(', ') + ' — these still hold stock' : 'all QA reservations are consumed/released/expired');
  if (lingering.length) {
    console.log('        An active/locked reservation keeps reservedQty held. Either let its TTL');
    console.log('        expire, or approve/reject the order to resolve it. Do NOT hand-edit stock.');
  }

  /* ---------- 4. seeded catalog untouched ---------- */
  console.log('\n--- 4. Seeded catalog integrity ---');
  const [productsSnap, patchesSnap] = await Promise.all([db.collection('products').get(), db.collection('patches').get()]);

  const realProducts = productsSnap.docs.filter((d) => !QA_ID_RE.test(d.id) && d.data().isTest !== true);
  const qaProducts = productsSnap.docs.filter((d) => QA_ID_RE.test(d.id) || d.data().isTest === true);
  const realPatches = patchesSnap.docs.filter((d) => !QA_ID_RE.test(d.id) && d.data().isTest !== true);

  console.log(`  info  products: ${realProducts.length} real, ${qaProducts.length} QA`);
  console.log(`  info  patches:  ${realPatches.length} real, ${patchesSnap.size - realPatches.length} QA`);

  // Any real product/patch still carrying reservedQty > 0 after QA is worth
  // a look: QA should only ever have reserved qa-* fixtures.
  const realWithReserved = [];
  for (const d of realProducts) {
    for (const v of d.data().variants || []) {
      if (Number(v.reservedQty) > 0) realWithReserved.push(`${d.data().title || d.id}/${v.variantId}=${v.reservedQty}`);
    }
  }
  for (const d of realPatches) {
    if (Number(d.data().reservedQty) > 0) realWithReserved.push(`patch ${d.data().name || d.id}=${d.data().reservedQty}`);
  }
  if (realWithReserved.length) {
    warn('real catalog items currently hold reservedQty', realWithReserved.join(', '));
    console.log('        This is only a problem if QA caused it. Real unpaid customer orders');
    console.log('        legitimately hold reservations too — cross-check against open orders.');
  } else {
    check('no real product/patch is holding reserved stock', true, 'all reservedQty are 0');
  }

  // Negative stock anywhere would mean the inventory engine was damaged.
  const negatives = [];
  for (const d of productsSnap.docs) {
    for (const v of d.data().variants || []) {
      if (Number(v.stockQty) < 0 || Number(v.reservedQty) < 0) negatives.push(`${d.id}/${v.variantId}`);
    }
  }
  for (const d of patchesSnap.docs) {
    if (Number(d.data().stockQty) < 0 || Number(d.data().reservedQty) < 0) negatives.push(`patch ${d.id}`);
  }
  check('no negative stockQty/reservedQty anywhere', negatives.length === 0, negatives.join(', ') || 'all non-negative');

  /* ---------- 5. historical pricing intact ---------- */
  console.log('\n--- 5. Historical order pricing intact ---');
  let badPricing = 0;
  let preFields = 0;
  for (const o of realOrders) {
    const p = o.pricing;
    if (!p || typeof p.total !== 'number' || typeof p.subtotal !== 'number' || typeof p.shippingFee !== 'number') {
      badPricing++;
      console.log(`  FAIL  ${o.orderNumber}: missing/invalid pricing snapshot`);
      continue;
    }
    if (p.subtotal + p.shippingFee !== p.total) {
      badPricing++;
      console.log(`  FAIL  ${o.orderNumber}: ${p.subtotal} + ${p.shippingFee} != ${p.total}`);
    }
    if (!o.destinationRegion || !o.deliveryAddress || !o.deliveryAddress.barangay) preFields++;
  }
  check('every non-QA order still has a consistent pricing snapshot', badPricing === 0,
    badPricing ? `${badPricing} problem(s) above` : `${realOrders.length} order(s) verified`);
  console.log(`  info  ${preFields} non-QA order(s) predate the 5D.2 fields (render as "Not recorded") — expected, never backfilled.`);

  /* ---------- summary ---------- */
  console.log('\n=== Summary ===');
  console.log(`  ${failures} failure(s), ${warnings} warning(s)`);
  console.log(`  Production checkout: ${pay.checkoutEnabled ? 'LIVE (!!)' : 'DISABLED'}`);
  console.log('  This script wrote nothing.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('Cleanup verification failed:', err);
  process.exit(1);
});
