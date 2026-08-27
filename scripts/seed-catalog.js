/*
 * ONE-TIME LOCAL SCRIPT — seeds Firestore with the same demo catalog the
 * storefront used as a static mock in Phases 2-4 (Everyday Pouch + 5 other
 * products, 8 patches, 1 collection), so there's real data to test the
 * admin panel and storefront against after switching off the mock files.
 *
 * Safe to re-run — every doc is written with a fixed, predictable ID via
 * .set(), so running this twice just overwrites the same seed data rather
 * than duplicating it.
 *
 * Usage: node scripts/seed-catalog.js
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

const PATCHES = [
  { id: 'patch_star', name: 'Star', hex: '#F6C453', price: 40, displayWidthPct: 17, displayHeightPct: 17 },
  { id: 'patch_heart', name: 'Heart', hex: '#F16861', price: 40, displayWidthPct: 17, displayHeightPct: 17 },
  { id: 'patch_rainbow', name: 'Rainbow', hex: '#7FB2E5', price: 40, displayWidthPct: 20, displayHeightPct: 15 },
  { id: 'patch_cloud', name: 'Cloud', hex: '#BFDED8', price: 40, displayWidthPct: 20, displayHeightPct: 14 },
  { id: 'patch_flower', name: 'Flower', hex: '#E88AA6', price: 40, displayWidthPct: 16, displayHeightPct: 16 },
  { id: 'patch_smiley', name: 'Smiley', hex: '#F6C453', price: 40, displayWidthPct: 16, displayHeightPct: 16 },
  { id: 'patch_bolt', name: 'Bolt', hex: '#38B2B3', price: 40, displayWidthPct: 13, displayHeightPct: 19 },
  { id: 'patch_moon', name: 'Moon', hex: '#9B8CD1', price: 40, displayWidthPct: 15, displayHeightPct: 15 },
];

const COLLECTIONS = [{ id: 'col_everyday_carry', name: 'Everyday Carry', slug: 'everyday-carry', description: 'Grab-and-go pieces for daily use.', sortOrder: 0 }];

function variant(variantId, name, hex, sku, stockQty) {
  return { variantId, name, hex, sku, stockQty, lowStockThreshold: 5, active: true, stageImage: '' };
}

const PRODUCTS = [
  {
    id: 'prod_everyday_pouch',
    title: 'Everyday Pouch',
    slug: 'everyday-pouch',
    description:
      'Sturdy canvas everyday pouch, handmade to order. Load it up with iron-on patches and add a name to make it fully yours — previewed live above. Ships nationwide in 1–2 working days.',
    category: 'pouches',
    collectionIds: ['col_everyday_carry'],
    basePrice: 260,
    active: true,
    featured: true,
    badge: '',
    thumbnail: '',
    gallery: [],
    variants: [
      variant('teal', 'Teal', '#38B2B3', 'POUCH-TEAL', 40),
      variant('coral', 'Coral', '#F16861', 'POUCH-CORAL', 40),
      variant('mint', 'Mint', '#BFDED8', 'POUCH-MINT', 40),
      variant('cream', 'Cream', '#EFE4CC', 'POUCH-CREAM', 40),
      variant('sky', 'Sky', '#A7D3E8', 'POUCH-SKY', 40),
      variant('blush', 'Blush', '#F4C4C0', 'POUCH-BLUSH', 40),
    ],
    customizable: true,
    customizationConfig: {
      boundary: { top: 12, left: 10, width: 80, height: 76 },
      allowText: true,
      textMaxLength: 10,
      textPrice: 30,
      textBoxSize: { width: 46, height: 13 },
      maxPatches: 6,
      availablePatchIds: PATCHES.map((p) => p.id),
    },
  },
  {
    id: 'prod_bag_tag',
    title: 'Bag Tag',
    slug: 'bag-tag',
    description: 'A small canvas bag tag — same patch-and-name customization as the pouch, sized down.',
    category: 'accessories',
    collectionIds: ['col_everyday_carry'],
    basePrice: 120,
    active: true,
    featured: true,
    badge: '',
    thumbnail: '',
    gallery: [],
    variants: [variant('default', 'Default', '#38B2B3', 'BAGTAG-DEFAULT', 60)],
    customizable: false,
    customizationConfig: null,
  },
  {
    id: 'prod_pencil_case',
    title: 'Pencil Case',
    slug: 'pencil-case',
    description: 'Roomy canvas pencil case, handmade to order.',
    category: 'accessories',
    collectionIds: [],
    basePrice: 320,
    active: true,
    featured: true,
    badge: '',
    thumbnail: '',
    gallery: [],
    variants: [variant('default', 'Default', '#F16861', 'PENCIL-DEFAULT', 25)],
    customizable: false,
    customizationConfig: null,
  },
  {
    id: 'prod_coin_purse',
    title: 'Coin Purse',
    slug: 'coin-purse',
    description: 'Compact canvas coin purse.',
    category: 'accessories',
    collectionIds: [],
    basePrice: 190,
    active: true,
    featured: true,
    badge: '',
    thumbnail: '',
    gallery: [],
    variants: [variant('default', 'Default', '#BFDED8', 'COIN-DEFAULT', 35)],
    customizable: false,
    customizationConfig: null,
  },
  {
    id: 'prod_patch_box',
    title: 'Patch Box',
    slug: 'patch-box',
    description: 'A curated box of patches — the combo starter set.',
    category: 'combo',
    collectionIds: [],
    basePrice: 790,
    active: true,
    featured: true,
    badge: 'COMBO',
    thumbnail: '',
    gallery: [],
    variants: [variant('default', 'Default', '#9B8CD1', 'PATCHBOX-DEFAULT', 15)],
    customizable: false,
    customizationConfig: null,
  },
  {
    id: 'prod_mini_tote',
    title: 'Mini Tote',
    slug: 'mini-tote',
    description: 'A small canvas tote — new this season.',
    category: 'bags',
    collectionIds: ['col_everyday_carry'],
    basePrice: 340,
    active: true,
    featured: false,
    badge: 'NEW',
    thumbnail: '',
    gallery: [],
    variants: [variant('default', 'Default', '#38B2B3', 'TOTE-DEFAULT', 0)],
    customizable: false,
    customizationConfig: null,
  },
];

async function main() {
  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();

  PATCHES.forEach((p) => {
    const ref = db.collection('patches').doc(p.id);
    batch.set(ref, { ...p, description: '', image: '', active: true, createdAt: now, createdBy: 'seed-script', updatedAt: now, updatedBy: 'seed-script' });
  });

  COLLECTIONS.forEach((c) => {
    const ref = db.collection('collections').doc(c.id);
    batch.set(ref, { ...c, image: '', active: true, featured: false, createdAt: now, createdBy: 'seed-script', updatedAt: now, updatedBy: 'seed-script' });
  });

  PRODUCTS.forEach((p) => {
    const ref = db.collection('products').doc(p.id);
    batch.set(ref, { ...p, createdAt: now, createdBy: 'seed-script', updatedAt: now, updatedBy: 'seed-script' });
    p.variants.forEach((v) => {
      const skuRef = db.collection('skuIndex').doc(v.sku);
      batch.set(skuRef, { sku: v.sku, productId: p.id, variantId: v.variantId });
    });
  });

  await batch.commit();
  console.log(`Seeded ${PATCHES.length} patches, ${COLLECTIONS.length} collection(s), ${PRODUCTS.length} products (+ their SKU index entries).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
