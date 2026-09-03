/*
 * PHASE 5D.2 QA — Step 3: dedicated, disposable QA catalog fixtures.
 *
 * Creates catalog records that are UNMISTAKABLY test data under every
 * convention this project already uses (see scripts/qa-test-guard.js):
 *   - document ids prefixed  qa-
 *   - titles/names prefixed  "ZZ QA"
 *   - isTest: true
 *
 * Normal seeded products/patches are never read for writing, never
 * modified, and never deleted by this script. It only ever touches
 * documents whose id starts with "qa-".
 *
 * Idempotent: re-running overwrites only the qa-* fixtures with the same
 * definitions. Safe to run repeatedly.
 *
 * Usage:
 *   node scripts/qa-seed-fixtures.js --dry-run
 *   node scripts/qa-seed-fixtures.js --apply
 *   node scripts/qa-seed-fixtures.js --remove     (deletes ONLY qa-* fixtures)
 *
 * Credentials: FIREBASE_SERVICE_ACCOUNT_JSON, or serviceAccountKey.json.
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const EXPECTED_PROJECT = 'buddy-shop-45fc4';
const QA_ID_RE = /^qa-/;

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const p = path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  console.error('No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON or add serviceAccountKey.json.');
  process.exit(1);
}

/*
 * Stock is set deliberately high enough to run the whole QA matrix
 * (multiple orders across pickup + three regions, plus a rejection and a
 * re-reservation) without a mid-QA stockout, but small enough that the
 * permanent deduction on approval is obvious when you check it.
 */
const QA_PATCHES = [
  {
    id: 'qa-patch-star',
    data: {
      name: 'ZZ QA Star Patch',
      hex: '#F2B705',
      image: '',
      price: 40,
      displayWidthPct: 17,
      displayHeightPct: 17,
      stockQty: 100,
      reservedQty: 0,
      lowStockThreshold: 5,
      active: true,
      isTest: true,
    },
  },
];

const QA_PRODUCTS = [
  {
    id: 'qa-product-pouch',
    data: {
      slug: 'qa-zz-qa-test-pouch',
      title: 'ZZ QA Test Pouch',
      description: 'QA TEST FIXTURE — not a real product. Safe to delete.',
      category: 'qa',
      collectionIds: [],
      basePrice: 500,
      thumbnail: '',
      gallery: [],
      featured: false,
      // Inactive on the storefront by default so it cannot be browsed to by
      // a real visitor. Flip to true only for the QA window if you need to
      // reach it through the normal catalog UI.
      active: false,
      customizable: false,
      variants: [
        {
          variantId: 'qa-teal',
          name: 'ZZ QA Teal',
          hex: '#38B2B3',
          sku: 'QA-POUCH-TEAL',
          stockQty: 100,
          reservedQty: 0,
          lowStockThreshold: 5,
          active: true,
          thumbnail: '',
          stageImage: '',
        },
      ],
      isTest: true,
    },
  },
];

async function main() {
  const apply = process.argv.includes('--apply');
  const dryRun = process.argv.includes('--dry-run');
  const remove = process.argv.includes('--remove');

  const modes = [apply, dryRun, remove].filter(Boolean).length;
  if (modes !== 1) {
    console.error('Pass exactly one of --dry-run | --apply | --remove');
    process.exit(1);
  }

  const sa = loadServiceAccount();
  if (sa.project_id !== EXPECTED_PROJECT) {
    console.error(`Refusing to run: expected project "${EXPECTED_PROJECT}", got "${sa.project_id}".`);
    process.exit(1);
  }
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  const targets = [
    ...QA_PATCHES.map((p) => ({ col: 'patches', ...p })),
    ...QA_PRODUCTS.map((p) => ({ col: 'products', ...p })),
  ];

  // Belt-and-braces: refuse to touch anything not obviously disposable,
  // even though every id here is hard-coded above.
  for (const t of targets) {
    if (!QA_ID_RE.test(t.id)) {
      console.error(`Refusing: "${t.id}" does not start with "qa-".`);
      process.exit(1);
    }
  }

  console.log(`=== QA fixtures (${remove ? 'REMOVE' : apply ? 'APPLY' : 'DRY RUN'}) ===`);
  console.log(`project: ${sa.project_id}\n`);

  if (remove) {
    for (const t of targets) {
      const snap = await db.collection(t.col).doc(t.id).get();
      if (!snap.exists) {
        console.log(`  skip   ${t.col}/${t.id} (not present)`);
        continue;
      }
      const d = snap.data();
      // Re-verify against the live document, not just the hard-coded id.
      if (d.isTest !== true && !QA_ID_RE.test(t.id)) {
        console.log(`  SKIP   ${t.col}/${t.id} — does not look like QA data`);
        continue;
      }
      await db.collection(t.col).doc(t.id).delete();
      console.log(`  removed ${t.col}/${t.id}`);
    }
    console.log('\nQA fixtures removed. Seeded/real catalog data was not touched.');
    process.exit(0);
  }

  for (const t of targets) {
    const label = `${t.col}/${t.id}`;
    if (dryRun) {
      console.log(`  would write ${label}  (${t.data.title || t.data.name}, isTest:true)`);
      continue;
    }
    await db
      .collection(t.col)
      .doc(t.id)
      .set(
        { ...t.data, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    console.log(`  wrote ${label}`);
  }

  if (dryRun) {
    console.log('\nDRY RUN — nothing was written.');
    process.exit(0);
  }

  console.log('\nQA fixtures ready.');
  console.log('NOTE: the QA product is created with active:false so real visitors cannot');
  console.log('reach it. Set active:true from Admin -> Products only for your QA window,');
  console.log('then set it back to false (or run --remove) afterwards.');
  console.log('\nQA product id: qa-product-pouch   variant: qa-teal   base ₱500');
  console.log('QA patch id:   qa-patch-star      ₱40');
  process.exit(0);
}

main().catch((err) => {
  console.error('QA fixture seeding failed:', err);
  process.exit(1);
});
