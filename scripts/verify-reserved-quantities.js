/*
 * ONE-TIME LOCAL SCRIPT — Phase 5D migration Step 3. READ-ONLY.
 *
 * Confirms every inventory-bearing product variant and patch has a numeric
 * reservedQty field after scripts/backfill-reserved-quantities.js has run.
 * Never writes anything. Exits with a non-zero code if any gaps remain, so
 * it's safe to treat "exit 0" as "clear to deploy the Firestore index and
 * Phase 5D application code."
 *
 * Usage: node scripts/verify-reserved-quantities.js
 * Credentials: same as the backfill script.
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

function hasNumericReservedQty(record) {
  return typeof record.reservedQty === 'number' && Number.isFinite(record.reservedQty);
}

async function main() {
  console.log('Loading credentials...');
  const serviceAccount = loadServiceAccount();
  console.log(`Using Firebase project: ${serviceAccount.project_id}`);

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();

  const gaps = [];

  console.log('\n=== Products ===');
  const productsSnap = await db.collection('products').get();
  for (const doc of productsSnap.docs) {
    const product = doc.data();
    for (const v of product.variants || []) {
      if (!hasNumericReservedQty(v)) {
        gaps.push(`Product "${product.title || doc.id}" variant "${v.variantId}" is missing numeric reservedQty (got: ${JSON.stringify(v.reservedQty)}).`);
      } else if (typeof v.stockQty === 'number' && v.reservedQty > v.stockQty) {
        gaps.push(`Product "${product.title || doc.id}" variant "${v.variantId}" has reservedQty (${v.reservedQty}) > stockQty (${v.stockQty}) — data integrity problem, not a migration gap.`);
      }
    }
  }
  console.log(`Checked ${productsSnap.size} product document(s).`);

  console.log('\n=== Patches ===');
  const patchesSnap = await db.collection('patches').get();
  for (const doc of patchesSnap.docs) {
    const patch = doc.data();
    if (!hasNumericReservedQty(patch)) {
      gaps.push(`Patch "${patch.name || doc.id}" is missing numeric reservedQty (got: ${JSON.stringify(patch.reservedQty)}).`);
    } else if (typeof patch.stockQty === 'number' && patch.reservedQty > patch.stockQty) {
      gaps.push(`Patch "${patch.name || doc.id}" has reservedQty (${patch.reservedQty}) > stockQty (${patch.stockQty}) — data integrity problem, not a migration gap.`);
    }
  }
  console.log(`Checked ${patchesSnap.size} patch document(s).`);

  if (gaps.length) {
    console.error(`\nFAILED — ${gaps.length} problem(s) found:`);
    gaps.forEach((g) => console.error('  - ' + g));
    process.exit(1);
  }

  console.log('\nPASSED — every variant and patch has a valid reservedQty <= stockQty. Safe to proceed to Step 4 (deploy the Firestore index).');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to verify reserved quantities:', err);
  process.exit(1);
});
