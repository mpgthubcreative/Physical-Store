/*
 * ONE-TIME LOCAL SCRIPT — sets isTest:true on a known, explicit list of
 * pre-existing QA/development orders. Deliberately an explicit allowlist
 * of order numbers rather than a pattern match (e.g. "email contains qa")
 * — this is a one-time human-reviewed cleanup of a known, finite set of
 * records, and an explicit list can't accidentally sweep up a real future
 * customer order the way a fuzzy heuristic could.
 *
 * Only ever touches the `isTest` field via .update() — never rewrites
 * items/paymentAttempts/history/pricing/etc, so historical snapshots stay
 * exactly as they were.
 *
 * Safe to re-run: setting isTest:true on an order that's already true is a
 * no-op change.
 *
 * Usage: node scripts/mark-qa-orders-as-test.js
 * Credentials: same as scripts/set-admin-claim.js — set
 * FIREBASE_SERVICE_ACCOUNT_JSON in your shell, or drop a serviceAccountKey.json
 * (gitignored) next to this script. Use Buddy's own service account.
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const localKeyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(localKeyPath)) {
    return JSON.parse(fs.readFileSync(localKeyPath, 'utf8'));
  }
  console.error('No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON or add serviceAccountKey.json.');
  process.exit(1);
}

// Every order created during Phase 5C QA and the historical-protection
// repair — all guest checkouts under clearly QA-labeled customer names.
const QA_ORDER_NUMBERS = [
  'BP-J2FXUY', // "QA Tester" — Phase 5C end-to-end checkout test
  'BP-862GUB', // "QA Valid Order Test" — aggregate inventory boundary test
  'BP-TMP9WX', // "QA Idem Reuse" — order-creation idempotency test
  'BP-JCUHHY', // "QA Diagnostic" — historical-protection repair diagnostic
  'BP-8XW9K2', // "ZZ QA Protection Test" — disposable delete-protection test
  'BP-LY4VY6', // "ZZ QA Image Protection Test" — disposable image-protection test
];

async function main() {
  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();

  const snap = await db.collection('orders').get();
  let marked = 0;
  let alreadyMarked = 0;
  const notFound = new Set(QA_ORDER_NUMBERS);
  const unexpectedTestLooking = [];

  for (const doc of snap.docs) {
    const order = doc.data();
    if (QA_ORDER_NUMBERS.includes(order.orderNumber)) {
      notFound.delete(order.orderNumber);
      if (order.isTest === true) {
        console.log(`${order.orderNumber}: already isTest:true, no change.`);
        alreadyMarked += 1;
        continue;
      }
      await doc.ref.update({ isTest: true });
      console.log(`${order.orderNumber}: set isTest:true.`);
      marked += 1;
    } else if (order.isTest !== true) {
      // Sanity cross-check only — never acted on automatically. Flags any
      // order that LOOKS like QA data but isn't in the explicit list above,
      // so a human can review it rather than it silently staying
      // untagged or being auto-tagged by a guess.
      const looksLikeQa = /qa/i.test(order.customerEmail || '') || /^(QA|ZZ QA)/i.test(order.customerName || '');
      if (looksLikeQa) unexpectedTestLooking.push(order.orderNumber);
    }
  }

  console.log(`\nMarked ${marked} order(s) as test, ${alreadyMarked} already were.`);
  if (notFound.size) {
    console.warn(`WARNING: these expected order numbers were not found in Firestore: ${[...notFound].join(', ')}`);
  }
  if (unexpectedTestLooking.length) {
    console.warn(`REVIEW SUGGESTED: these orders look like QA data by name/email but are NOT in the explicit list and were NOT modified: ${unexpectedTestLooking.join(', ')}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to mark QA orders as test:', err);
  process.exit(1);
});
