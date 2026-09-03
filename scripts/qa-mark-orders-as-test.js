/*
 * PHASE 5D.2 QA — Step 17: set isTest:true on the orders created during the
 * QA window.
 *
 * Same reasoning and safety pattern as
 * scripts/mark-phase5d-qa-orders-as-test.js: an EXPLICIT list of order
 * numbers, reviewed by a human before running — never a broad pattern match
 * over the collection. The difference is only that the list is passed in on
 * the command line, because the Phase 5D.2 QA order numbers are not known
 * until the QA pass actually runs.
 *
 * Only ever touches the `isTest` field via .update(). It never rewrites
 * items, pricing, paymentAttempts, history, or reservation state — every
 * order's historical snapshot and the QA pass's evidence trail stay exactly
 * as they were. Historical pricing is never recalculated or modified.
 *
 * Refuses to mark an order that does not look like QA data unless --force is
 * passed with an explicit acknowledgement, so a mistyped order number cannot
 * quietly relabel a real customer order as a test.
 *
 * Safe to re-run: setting isTest:true on an order already true is a no-op.
 *
 * Usage:
 *   node scripts/qa-mark-orders-as-test.js --dry-run --orders BP-AAA111,BP-BBB222
 *   node scripts/qa-mark-orders-as-test.js --apply   --orders BP-AAA111,BP-BBB222
 *
 * Credentials: FIREBASE_SERVICE_ACCOUNT_JSON, or serviceAccountKey.json.
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const EXPECTED_PROJECT = 'buddy-shop-45fc4';

// What "obviously disposable QA data" means here — same conventions as
// scripts/qa-test-guard.js, applied to an ORDER rather than a catalog record.
const QA_NAME_RE = /^ZZ QA/i;
const QA_EMAIL_RE = /(^|[+@])qa[+@.-]|@example\.(com|org|net)$/i;
const QA_PRODUCT_ID_RE = /^qa-/i;

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

/**
 * Does this order look like disposable QA data? True if ANY of:
 *   - customer name starts with "ZZ QA"
 *   - customer email looks like a QA/example address
 *   - every line references a qa-* product
 *   - it is already marked isTest
 */
function looksLikeQaOrder(order) {
  if (order.isTest === true) return true;
  if (QA_NAME_RE.test(String(order.customerName || ''))) return true;
  if (QA_EMAIL_RE.test(String(order.customerEmail || ''))) return true;
  const ids = order.referencedProductIds || [];
  if (ids.length && ids.every((id) => QA_PRODUCT_ID_RE.test(id))) return true;
  return false;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');

  if (apply === dryRun) {
    console.error('Pass exactly one of --dry-run | --apply');
    console.error('  node scripts/qa-mark-orders-as-test.js --dry-run --orders BP-AAA111,BP-BBB222');
    process.exit(1);
  }

  const raw = arg('orders');
  if (!raw) {
    console.error('Missing --orders. Pass a comma-separated list of order numbers.');
    process.exit(1);
  }
  const orderNumbers = [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!orderNumbers.length) {
    console.error('No order numbers parsed from --orders.');
    process.exit(1);
  }

  const sa = loadServiceAccount();
  if (sa.project_id !== EXPECTED_PROJECT) {
    console.error(`Refusing to run: expected project "${EXPECTED_PROJECT}", got "${sa.project_id}".`);
    process.exit(1);
  }
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  console.log(`=== Mark QA orders isTest:true (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  console.log(`project: ${sa.project_id}`);
  console.log(`orders:  ${orderNumbers.length}\n`);

  const toMark = [];
  const notFound = [];
  const refused = [];
  const already = [];

  for (const orderNumber of orderNumbers) {
    const snap = await db.collection('orders').where('orderNumber', '==', orderNumber).limit(1).get();
    if (snap.empty) {
      notFound.push(orderNumber);
      console.log(`  NOT FOUND  ${orderNumber}`);
      continue;
    }
    const doc = snap.docs[0];
    const order = doc.data();

    if (order.isTest === true) {
      already.push(orderNumber);
      console.log(`  already    ${orderNumber}  (isTest already true)`);
      continue;
    }

    const safe = looksLikeQaOrder(order);
    const label = `${orderNumber}  "${order.customerName}" <${order.customerEmail}>  ${order.paymentStatus}/${order.fulfillmentStatus}`;

    if (!safe && !force) {
      refused.push(orderNumber);
      console.log(`  REFUSED    ${label}`);
      console.log(`             does not look like QA data (name not "ZZ QA*", email not a QA/example address,`);
      console.log(`             and not all lines are qa-* products). Re-run with --force only if you are certain.`);
      continue;
    }
    toMark.push({ ref: doc.ref, orderNumber, label, forced: !safe });
    console.log(`  will mark  ${label}${!safe ? '   [FORCED]' : ''}`);
  }

  console.log('');
  if (!toMark.length) {
    console.log('Nothing to mark.');
    if (refused.length) console.log(`${refused.length} order(s) refused as not-obviously-QA.`);
    process.exit(refused.length ? 1 : 0);
  }

  if (dryRun) {
    console.log(`DRY RUN — ${toMark.length} order(s) would be marked. Nothing was written.`);
    process.exit(0);
  }

  for (const t of toMark) {
    // ONLY the isTest field. Nothing else on the order is read for writing
    // or modified — pricing, items, attempts, and history are untouched.
    await t.ref.update({ isTest: true });
    console.log(`  marked  ${t.orderNumber}`);
  }

  /* ---------- verification ---------- */
  console.log('\n=== Verification ===');
  let bad = 0;
  for (const orderNumber of orderNumbers) {
    const snap = await db.collection('orders').where('orderNumber', '==', orderNumber).limit(1).get();
    if (snap.empty) continue;
    const isTest = snap.docs[0].data().isTest === true;
    console.log(`  ${isTest ? 'OK  ' : 'FAIL'}  ${orderNumber}: isTest=${isTest}`);
    if (!isTest) bad++;
  }

  console.log('');
  console.log(`marked: ${toMark.length}   already: ${already.length}   refused: ${refused.length}   not found: ${notFound.length}`);
  if (notFound.length) console.log(`NOT FOUND: ${notFound.join(', ')}`);
  if (refused.length) console.log(`REFUSED:   ${refused.join(', ')}`);
  console.log(bad ? `\n${bad} order(s) still not marked — investigate.` : '\nAll listed orders are isTest:true.');

  process.exit(bad || refused.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Marking failed:', err);
  process.exit(1);
});
