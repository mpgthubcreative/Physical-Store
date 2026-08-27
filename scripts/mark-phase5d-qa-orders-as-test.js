/*
 * ONE-TIME LOCAL SCRIPT — sets isTest:true on the explicit, known list of
 * orders created during the Phase 5D QA pass (all guest checkouts under
 * "ZZ QA Tester", created against the disposable ZZ QA Inv Product/Patch
 * fixtures). Same reasoning and pattern as scripts/mark-qa-orders-as-test.js
 * from the Phase 5C/historical-protection QA passes — an explicit allowlist
 * rather than a pattern match, reviewed by a human before running.
 *
 * Only ever touches the `isTest` field via .update() — never rewrites
 * items/paymentAttempts/history/pricing/reservation state, so every
 * order's historical snapshot and the QA pass's evidence trail stay
 * exactly as they were.
 *
 * Safe to re-run: setting isTest:true on an order that's already true is a
 * no-op change.
 *
 * Usage: node scripts/mark-phase5d-qa-orders-as-test.js
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

// Every order created during the Phase 5D QA pass — all guest checkouts
// under "ZZ QA Tester" against the disposable ZZ QA Inv Product/Patch
// fixtures (Solo/Multi/Race products, Solo/Multi patches), now archived.
const QA_ORDER_NUMBERS = [
  'BP-9G4AHQ', // basic reservation creation (Solo) — later paid/consumed
  'BP-WCFKCM', // aggregate-by-document (Race ra+rb)
  'BP-3UVN5E', // aggregate demand across multiple lines (Race rb x2)
  'BP-VJZMV6', // patch instances x quantity (Race rc + PatchMulti x3) — later paid/consumed
  'BP-TJEN4Z', // final-unit variant race winner (Race rc)
  'BP-TELWWZ', // final-unit variant race winner (Race rc)
  'BP-64D7Q2', // final-unit variant race winner (Race rc) — later lazily expired
  'BP-33GJMV', // final-unit patch race winner (Race ra + PatchSolo)
  'BP-4QS778', // final-unit patch race winner (Race ra + PatchSolo)
  'BP-4AGDFW', // claimed the unit freed by BP-64D7Q2's expiry
  'BP-VDJPHE', // isolated active-reservation delete-protection test (Multi v1)
  'BP-GK94S3', // idempotent create-order retry test (Multi v2)
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
    }
  }

  console.log(`\nMarked ${marked} order(s) as test, ${alreadyMarked} already were.`);
  if (notFound.size) {
    console.warn(`WARNING: these expected order numbers were not found in Firestore: ${[...notFound].join(', ')}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to mark Phase 5D QA orders as test:', err);
  process.exit(1);
});
