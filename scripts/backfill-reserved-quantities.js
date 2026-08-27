/*
 * ONE-TIME LOCAL SCRIPT — Phase 5D migration Step 1/2.
 *
 * Adds reservedQty: 0 to every product variant and every patch that
 * currently lacks a numeric reservedQty field. NEVER touches stockQty.
 * NEVER overwrites an existing numeric reservedQty — unlike
 * scripts/backfill-order-references.js (which always recomputes a pure
 * function of immutable data), reservedQty is STATEFUL. Once Phase 5D
 * application code is live, real reservations will have incremented real
 * reservedQty values, and re-running this script must never stomp those
 * back to 0. "Backfill where absent" is the entire contract here — this
 * script only ever fills in a genuinely missing/non-numeric field.
 *
 * Products embed variants in one array field, so per the aggregate-by-
 * document rule (Phase 5D correction #11), each product document is read
 * once and written once with its full updated variants array — never one
 * write per variant.
 *
 * Safe to re-run any number of times: a product/patch that already has
 * reservedQty on every variant is a no-op.
 *
 * Usage: node scripts/backfill-reserved-quantities.js
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

function hasNumericReservedQty(record) {
  return typeof record.reservedQty === 'number' && Number.isFinite(record.reservedQty);
}

async function backfillProducts(db) {
  console.log('\n=== Products ===');
  const snap = await db.collection('products').get();
  console.log(`Found ${snap.size} product document(s).`);

  let productsUpdated = 0;
  let variantsFilled = 0;

  for (const doc of snap.docs) {
    const product = doc.data();
    const variants = product.variants || [];
    if (!variants.length) continue;

    let changed = false;
    const before = variants.map((v) => ({ variantId: v.variantId, stockQty: v.stockQty, reservedQty: v.reservedQty }));
    const updatedVariants = variants.map((v) => {
      if (hasNumericReservedQty(v)) return v;
      changed = true;
      variantsFilled += 1;
      return { ...v, reservedQty: 0 };
    });

    if (!changed) {
      console.log(`- ${product.title || doc.id}: all ${variants.length} variant(s) already have reservedQty. Skipped.`);
      continue;
    }

    console.log(`- ${product.title || doc.id}:`);
    console.log('    before:', JSON.stringify(before));
    console.log('    after: ', JSON.stringify(updatedVariants.map((v) => ({ variantId: v.variantId, stockQty: v.stockQty, reservedQty: v.reservedQty }))));

    await doc.ref.update({ variants: updatedVariants });
    productsUpdated += 1;
  }

  console.log(`\nProducts: updated ${productsUpdated} document(s), filled reservedQty on ${variantsFilled} variant(s).`);
}

async function backfillPatches(db) {
  console.log('\n=== Patches ===');
  const snap = await db.collection('patches').get();
  console.log(`Found ${snap.size} patch document(s).`);

  let patchesUpdated = 0;

  for (const doc of snap.docs) {
    const patch = doc.data();
    if (hasNumericReservedQty(patch)) {
      console.log(`- ${patch.name || doc.id}: already has reservedQty (${patch.reservedQty}). Skipped.`);
      continue;
    }

    console.log(`- ${patch.name || doc.id}:`);
    console.log('    before:', JSON.stringify({ stockQty: patch.stockQty, reservedQty: patch.reservedQty }));
    console.log('    after: ', JSON.stringify({ stockQty: patch.stockQty, reservedQty: 0 }));

    await doc.ref.update({ reservedQty: 0 });
    patchesUpdated += 1;
  }

  console.log(`\nPatches: updated ${patchesUpdated} document(s).`);
}

async function main() {
  console.log('Loading credentials...');
  const serviceAccount = loadServiceAccount();
  console.log(`Using Firebase project: ${serviceAccount.project_id}`);

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();

  await backfillProducts(db);
  await backfillPatches(db);

  console.log('\nDone. stockQty was never modified by this script.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to backfill reserved quantities:', err);
  process.exit(1);
});
