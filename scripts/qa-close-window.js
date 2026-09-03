/*
 * PHASE 5D.2 QA — Step 16: CLOSE THE QA WINDOW.
 *
 * Sets settings/payment.checkoutEnabled to false and then proves it from
 * THREE independent angles, because "the Admin toggle looks off" is not
 * evidence:
 *
 *   1. Firestore directly — the stored field is literally false.
 *   2. /api/public-settings on the deployed site — what a browser is told.
 *   3. POST /api/create-order on the deployed site — the server actually
 *      refuses to create an order (503 CHECKOUT_DISABLED).
 *
 * Check 3 is the one that matters: it exercises the real enforcement path
 * rather than trusting a flag anywhere.
 *
 * Optionally also disables the temporary QA payment methods with
 * --disable-methods, so QA GCash/bank details stop being shown to anyone.
 * Account details are left in place (not wiped) so you can see what was
 * configured; they are simply switched off. Use --clear-methods to blank
 * the QA values as well.
 *
 * This script only ever writes settings/payment. It never touches orders,
 * products, patches, or reservations.
 *
 * Usage:
 *   node scripts/qa-close-window.js --url https://YOURSITE.netlify.app
 *   node scripts/qa-close-window.js --url https://YOURSITE.netlify.app --disable-methods
 *   node scripts/qa-close-window.js --url https://YOURSITE.netlify.app --clear-methods
 *
 * Credentials: FIREBASE_SERVICE_ACCOUNT_JSON, or serviceAccountKey.json.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const EXPECTED_PROJECT = 'buddy-shop-45fc4';

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
function check(label, pass, detail) {
  console.log(`  ${pass ? 'OK  ' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!pass) failures++;
}

async function main() {
  const BASE = (arg('url') || '').replace(/\/$/, '');
  const disableMethods = process.argv.includes('--disable-methods');
  const clearMethods = process.argv.includes('--clear-methods');

  const sa = loadServiceAccount();
  if (sa.project_id !== EXPECTED_PROJECT) {
    console.error(`Refusing to run: expected project "${EXPECTED_PROJECT}", got "${sa.project_id}".`);
    process.exit(1);
  }
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  const ref = db.collection('settings').doc('payment');

  console.log('=== Closing the Phase 5D.2 QA window ===');
  console.log(`project: ${sa.project_id}\n`);

  const before = (await ref.get()).data() || {};
  console.log(`  before: checkoutEnabled=${before.checkoutEnabled === true}`);
  console.log(`          gcash.enabled=${!!(before.gcash && before.gcash.enabled)}  bank.enabled=${!!(before.bank && before.bank.enabled)}`);

  /* ---------- write ---------- */
  const patch = { checkoutEnabled: false };

  if (disableMethods || clearMethods) {
    patch.gcash = clearMethods
      ? { enabled: false, accountName: '', mobileNumber: '', instructions: '' }
      : { enabled: false };
    patch.bank = clearMethods
      ? { enabled: false, bankName: '', accountName: '', accountNumber: '', instructions: '' }
      : { enabled: false };
  }

  // merge:true — never removes qrImagePath, the legacy methods[] array, or
  // any other key on the document.
  await ref.set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: 'qa-close-window' }, { merge: true });
  console.log(`\n  wrote checkoutEnabled:false${disableMethods ? ' + disabled QA methods' : ''}${clearMethods ? ' + cleared QA method details' : ''}`);

  /* ---------- proof 1: Firestore ---------- */
  console.log('\n--- Proof 1: Firestore (source of truth) ---');
  const after = (await ref.get()).data() || {};
  check('settings/payment.checkoutEnabled === false', after.checkoutEnabled === false, `stored value: ${JSON.stringify(after.checkoutEnabled)}`);
  if (disableMethods || clearMethods) {
    check('gcash disabled', !(after.gcash && after.gcash.enabled === true));
    check('bank disabled', !(after.bank && after.bank.enabled === true));
  }
  // Confirm nothing was destroyed on the way.
  if (before.methods !== undefined) {
    check('legacy methods[] still present', JSON.stringify(after.methods) === JSON.stringify(before.methods));
  }
  if (before.gcash && before.gcash.qrImagePath) {
    check('gcash QR path preserved', after.gcash && after.gcash.qrImagePath === before.gcash.qrImagePath);
  }
  if (before.bank && before.bank.qrImagePath) {
    check('bank QR path preserved', after.bank && after.bank.qrImagePath === before.bank.qrImagePath);
  }

  /* ---------- proofs 2 + 3: the deployed site ---------- */
  if (!BASE) {
    console.log('\n  No --url given, so the deployed site was not checked.');
    console.log('  Re-run with --url https://YOURSITE.netlify.app to prove it end-to-end.');
  } else {
    console.log(`\n--- Proof 2: /api/public-settings on ${BASE} ---`);
    try {
      const res = await fetch(BASE + '/api/public-settings', { headers: { 'Cache-Control': 'no-cache' } });
      const body = await res.json();
      check('public-settings reports checkoutEnabled:false', body.checkoutEnabled === false, `got ${JSON.stringify(body.checkoutEnabled)}`);
      const enabled = (body.paymentMethods || []).map((m) => m.id);
      console.log(`  info  payment methods still shown to customers: ${enabled.length ? enabled.join(', ') : 'none'}`);
      if (enabled.length && (disableMethods || clearMethods)) {
        check('no QA payment method still advertised', enabled.length === 0, enabled.join(', '));
      }
    } catch (err) {
      check('public-settings reachable', false, err.message);
    }

    console.log(`\n--- Proof 3: create-order is actually refused ---`);
    try {
      const res = await fetch(BASE + '/api/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          orderAccessToken: crypto.randomBytes(32).toString('hex'),
          customer: { fullName: 'ZZ QA Closure Probe', email: 'qa+closure@example.com', mobile: '09170000000' },
          deliveryMethod: 'pickup',
          destinationRegion: null,
          deliveryAddress: null,
          orderNotes: 'QA closure probe — must be refused',
          items: [{ productId: 'qa-product-pouch', variantId: 'qa-teal', quantity: 1, personalization: null, patches: [] }],
        }),
      });
      const body = await res.json().catch(() => ({}));
      const refused = res.status === 503 && body.error === 'CHECKOUT_DISABLED';
      check('create-order refused with 503 CHECKOUT_DISABLED', refused, `status ${res.status} ${JSON.stringify(body)}`);
      if (res.status === 200) {
        console.log('  !! AN ORDER WAS CREATED BY THIS PROBE — mark it isTest immediately:');
        console.log(`     node scripts/qa-mark-orders-as-test.js --apply --orders ${body.orderNumber}`);
      }
    } catch (err) {
      check('create-order reachable', false, err.message);
    }
  }

  console.log('\n=== Result ===');
  if (failures) {
    console.log(`  ${failures} CHECK(S) FAILED — the QA window may still be open. Investigate now.`);
  } else {
    console.log('  QA window CLOSED. Production checkout is disabled and independently verified.');
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('Closing the QA window failed:', err);
  process.exit(1);
});
