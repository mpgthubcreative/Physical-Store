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
 * Safe to re-run: only touches orders missing referencedProductIds, and
 * recomputes deterministically from that order's own items[] snapshot —
 * never reads live catalog data, so it can't drift.
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
  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();

  const snap = await db.collection('orders').get();
  let updated = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const order = doc.data();
    if (order.referencedProductIds) {
      skipped += 1;
      continue;
    }
    const refs = computeReferences(order.items);
    await doc.ref.update(refs);
    console.log(`Backfilled ${order.orderNumber || doc.id}:`, JSON.stringify(refs));
    updated += 1;
  }

  console.log(`Done. Updated ${updated} order(s), skipped ${skipped} already-backfilled order(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to backfill order references:', err);
  process.exit(1);
});
