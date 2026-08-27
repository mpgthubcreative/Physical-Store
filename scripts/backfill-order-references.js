/*
 * ONE-TIME LOCAL SCRIPT — backfills referencedProductIds/referencedPatchIds/
 * referencedImagePaths onto every order that predates those fields (i.e.
 * every order created before the historical-delete/image protections in
 * admin-delete-product.js, admin-delete-patch.js, and
 * admin-remove-image.js). Without this, a pre-migration order's referenced
 * product/patch/image would NOT be protected from permanent deletion,
 * because _shared/orderReferences.js's array-contains lookups would never
 * find that order.
 *
 * Idempotent by ALWAYS recomputing and overwriting every order's three
 * fields, unconditionally, rather than skipping orders that already "have"
 * the fields. This is a deliberate correction from an earlier version of
 * this script, which skipped any order where `order.referencedProductIds`
 * was truthy — but an empty array `[]` is ALSO truthy in JavaScript, so if
 * that field were ever `[]` for any reason, the old skip-check would
 * silently treat the order as "already correctly backfilled" forever,
 * masking the very drift this script exists to repair. Since the
 * computation is a pure, deterministic function of order.items (which
 * never changes after order creation), there is no correctness cost to
 * always recomputing — every run produces the exact same result for the
 * exact same order, so running it twice, or a hundred times, is safe.
 *
 * Every order's full before/after state is logged so a run is fully
 * auditable — if a future run ever appears to fail silently again, the
 * printed output is enough to diagnose it without guessing.
 *
 * Usage: node scripts/backfill-order-references.js
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

function computeReferences(items) {
  const referencedProductIds = [...new Set((items || []).map((l) => l.productId).filter(Boolean))];
  const referencedPatchIds = [
    ...new Set((items || []).flatMap((l) => (l.customization ? l.customization.patches.map((p) => p.patchId) : []))),
  ];
  const referencedImagePaths = [
    ...new Set([
      ...(items || []).map((l) => l.thumbnailImagePath).filter(Boolean),
      ...(items || []).map((l) => (l.customization ? l.customization.variant.stageImagePath : null)).filter(Boolean),
      ...(items || []).flatMap((l) => (l.customization ? l.customization.patches.map((p) => p.imagePath) : [])).filter(Boolean),
    ]),
  ];
  return { referencedProductIds, referencedPatchIds, referencedImagePaths };
}

async function main() {
  console.log('Loading credentials...');
  const serviceAccount = loadServiceAccount();
  console.log(`Using Firebase project: ${serviceAccount.project_id}`);

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();

  console.log('Reading orders collection...');
  const snap = await db.collection('orders').get();
  console.log(`Found ${snap.size} order document(s).`);

  if (snap.empty) {
    console.log('No orders found — nothing to do. (If you expected orders to exist, double-check the project ID above.)');
    process.exit(0);
  }

  let updated = 0;

  for (const doc of snap.docs) {
    const order = doc.data();
    const itemCount = Array.isArray(order.items) ? order.items.length : 0;
    console.log(`\n--- ${order.orderNumber || doc.id} (${itemCount} item(s)) ---`);
    console.log('  before:', JSON.stringify({
      referencedProductIds: order.referencedProductIds,
      referencedPatchIds: order.referencedPatchIds,
      referencedImagePaths: order.referencedImagePaths,
    }));

    if (itemCount === 0) {
      console.warn(`  WARNING: order.items is empty or missing for ${order.orderNumber || doc.id} — writing empty reference arrays. This order will NOT protect any product/patch/image.`);
    }

    const refs = computeReferences(order.items);
    console.log('  computed:', JSON.stringify(refs));

    await doc.ref.update(refs);
    updated += 1;
  }

  console.log(`\nDone. Wrote reference fields to ${updated} order(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to backfill order references:', err);
  process.exit(1);
});
