/*
 * ONE-TIME / RE-RUNNABLE LOCAL SCRIPT — strictly READ-ONLY.
 *
 * Performs no .set()/.update()/.delete()/transaction of any kind — every
 * Firestore call here is a .get(). Run this BEFORE the Phase 5D.2 migration
 * to see exactly what shape production's settings documents are in, and
 * after, to confirm what changed.
 *
 * Reports, for each of settings/shipping and settings/payment:
 *   - the raw stored keys (so nothing can be "silently dropped" unnoticed)
 *   - which shape the normalizer resolves it to
 *   - the effective values the server would actually use right now
 *
 * Never prints the service-account JSON, any private key, or a customer
 * token — only store configuration.
 *
 * Usage: node scripts/inspect-settings-schema.js
 * Credentials: FIREBASE_SERVICE_ACCOUNT_JSON in your shell, or a local
 * serviceAccountKey.json (gitignored) beside this script.
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'buddy-shop-45fc4.firebasestorage.app';
const { normalizeShippingSettings, normalizePaymentSettings } = require('../netlify/functions/_shared/settings');

const EXPECTED_PROJECT = 'buddy-shop-45fc4';

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const localKeyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(localKeyPath)) return JSON.parse(fs.readFileSync(localKeyPath, 'utf8'));
  console.error('No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON or add serviceAccountKey.json.');
  process.exit(1);
}

/** Redacts nothing structural — just shows key presence and value types/values for config. */
function describeRaw(data) {
  if (!data) return '  (document does not exist)';
  return Object.keys(data)
    .sort()
    .map((k) => {
      const v = data[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.toDate !== 'function') {
        return `  ${k}: { ${Object.keys(v).sort().join(', ')} }`;
      }
      if (Array.isArray(v)) return `  ${k}: [array of ${v.length}]`;
      if (v && typeof v.toDate === 'function') return `  ${k}: <timestamp>`;
      return `  ${k}: ${JSON.stringify(v)}`;
    })
    .join('\n');
}

async function main() {
  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  console.log('=== Firebase project ===');
  console.log(`project_id: ${serviceAccount.project_id}`);
  if (serviceAccount.project_id !== EXPECTED_PROJECT) {
    console.warn(`WARNING: expected "${EXPECTED_PROJECT}", got "${serviceAccount.project_id}". Stopping.`);
    process.exit(1);
  }

  const [shipSnap, paySnap] = await Promise.all([
    db.collection('settings').doc('shipping').get(),
    db.collection('settings').doc('payment').get(),
  ]);

  const shipRaw = shipSnap.exists ? shipSnap.data() : null;
  const payRaw = paySnap.exists ? paySnap.data() : null;

  console.log('\n=== settings/shipping — RAW stored keys ===');
  console.log(describeRaw(shipRaw));

  const ship = normalizeShippingSettings(shipRaw);
  console.log('\n--- normalized (what the server would use) ---');
  console.log(`  ratesSource:            ${ship.ratesSource}`);
  console.log(`  deliveryEnabled:        ${ship.deliveryEnabled}`);
  console.log(`  pickupEnabled:          ${ship.pickupEnabled}`);
  console.log(`  pickupFee:              ${ship.pickupFee}`);
  console.log(`  freeShippingThreshold:  ${ship.freeShippingThreshold}`);
  console.log(`  rates.luzon:            ${ship.rates.luzon}`);
  console.log(`  rates.visayas:          ${ship.rates.visayas}`);
  console.log(`  rates.mindanao:         ${ship.rates.mindanao}`);
  console.log(`  legacyFlatRateDelivery: ${ship.legacyFlatRateDelivery}  (preserved, never deleted)`);

  console.log('\n=== settings/payment — RAW stored keys ===');
  console.log(describeRaw(payRaw));

  const pay = normalizePaymentSettings(payRaw);
  console.log('\n--- normalized (what the server would use) ---');
  console.log(`  checkoutEnabled:  ${pay.checkoutEnabled}${pay.checkoutEnabled ? '   <-- STORE IS LIVE' : '   (store cannot take orders)'}`);
  console.log(`  hasNewShape:      ${pay.hasNewShape}`);
  console.log(`  legacy methods[]: ${pay.legacyMethods.length} entr${pay.legacyMethods.length === 1 ? 'y' : 'ies'} (preserved, never deleted)`);
  console.log(`  merged methods:   ${pay.methods.length}`);
  for (const m of pay.methods) {
    console.log(`    - ${m.id} (${m.label}) enabled=${m.enabled} qr=${m.qrImagePath ? 'yes' : 'no'}`);
  }
  const enabled = pay.methods.filter((m) => m.enabled);
  console.log(`  enabled methods:  ${enabled.length ? enabled.map((m) => m.id).join(', ') : 'NONE'}`);

  console.log('\n=== Migration readiness ===');
  if (ship.ratesSource === 'regional') {
    console.log('  shipping: already on the regional shape — migration would be a no-op.');
  } else {
    console.log(`  shipping: currently "${ship.ratesSource}" — migration would ADD rates{} (legacy flat rate kept).`);
  }
  console.log(payRaw && payRaw.checkoutEnabled !== undefined
    ? '  payment:  checkoutEnabled already present.'
    : '  payment:  checkoutEnabled absent — migration would ADD it as false (reads as false either way).');

  process.exit(0);
}

main().catch((err) => {
  console.error('Inspection failed:', err);
  process.exit(1);
});
