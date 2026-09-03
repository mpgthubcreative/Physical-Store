/*
 * PHASE 5D.2 SETTINGS MIGRATION — ADDITIVE AND IDEMPOTENT.
 *
 * ---- What this does NOT do ----
 *   - It never deletes a field. `flatRateDelivery` and `methods[]` are left
 *     exactly as production holds them.
 *   - It never touches the `orders` collection. No historical order's
 *     pricing, shipping fee, total, or any other field is read for writing
 *     or rewritten by this script, ever.
 *   - It never enables checkout. `checkoutEnabled` is only ever written as
 *     false, and only when the field is absent entirely.
 *   - It never enables a payment method or fills in account details.
 *
 * ---- What it does ----
 *   1. settings/shipping: if regional `rates` are missing/incomplete, adds
 *      them. Uses the approved V1 defaults (150/180/200) unless a legacy
 *      `flatRateDelivery` exists, in which case that value is carried into
 *      all three regions so pricing behavior does not change on deploy.
 *   2. settings/payment: adds `checkoutEnabled: false` if absent, and
 *      creates empty disabled `gcash`/`bank` config objects if absent, so
 *      the Admin Settings form has somewhere to write.
 *
 * ---- Why it is OPTIONAL ----
 * _shared/settings.js normalizes both the old and new shapes, so the
 * application is already correct against completely un-migrated data. This
 * script exists to make the stored shape match the new code, not to make
 * the new code work.
 *
 * Idempotent: re-running changes nothing once applied. Run with --dry-run
 * first to print the exact writes without performing them.
 *
 * Usage:
 *   node scripts/migrate-settings-5d2.js --dry-run
 *   node scripts/migrate-settings-5d2.js --apply
 *
 * Credentials: FIREBASE_SERVICE_ACCOUNT_JSON in your shell, or a local
 * serviceAccountKey.json (gitignored).
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'buddy-shop-45fc4.firebasestorage.app';
const { normalizeShippingSettings, normalizePaymentSettings, DESTINATION_REGIONS } = require('../netlify/functions/_shared/settings');

const EXPECTED_PROJECT = 'buddy-shop-45fc4';

// The V1 defaults approved for Phase 5D.2.
const DEFAULT_RATES = { luzon: 150, visayas: 180, mindanao: 200 };
const DEFAULT_PICKUP_FEE = 0;

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const localKeyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(localKeyPath)) return JSON.parse(fs.readFileSync(localKeyPath, 'utf8'));
  console.error('No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON or add serviceAccountKey.json.');
  process.exit(1);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dryRun = process.argv.includes('--dry-run');

  if (!apply && !dryRun) {
    console.error('Refusing to run without an explicit mode.\n  node scripts/migrate-settings-5d2.js --dry-run\n  node scripts/migrate-settings-5d2.js --apply');
    process.exit(1);
  }
  if (apply && dryRun) {
    console.error('Pass either --dry-run or --apply, not both.');
    process.exit(1);
  }

  const serviceAccount = loadServiceAccount();
  if (serviceAccount.project_id !== EXPECTED_PROJECT) {
    console.error(`Refusing to run: expected project "${EXPECTED_PROJECT}", got "${serviceAccount.project_id}".`);
    process.exit(1);
  }
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  console.log(`=== Phase 5D.2 settings migration (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  console.log(`project: ${serviceAccount.project_id}\n`);

  const shipRef = db.collection('settings').doc('shipping');
  const payRef = db.collection('settings').doc('payment');
  const [shipSnap, paySnap] = await Promise.all([shipRef.get(), payRef.get()]);
  const shipRaw = shipSnap.exists ? shipSnap.data() : null;
  const payRaw = paySnap.exists ? paySnap.data() : null;

  const writes = [];

  /* ---------------- settings/shipping ---------------- */
  const ship = normalizeShippingSettings(shipRaw);
  const missingRegions = DESTINATION_REGIONS.filter((r) => !(shipRaw && shipRaw.rates && shipRaw.rates[r] != null));

  if (missingRegions.length === 0) {
    console.log('settings/shipping: regional rates already present for all three regions — no change.');
  } else {
    // Carry a legacy flat rate forward rather than silently repricing the
    // store. Only fall back to the approved V1 defaults when there is no
    // legacy rate to preserve.
    const source = ship.legacyFlatRateDelivery != null ? 'legacy flatRateDelivery' : 'approved V1 defaults';
    const rates = { ...(shipRaw && shipRaw.rates ? shipRaw.rates : {}) };
    for (const region of missingRegions) {
      rates[region] = ship.legacyFlatRateDelivery != null ? ship.legacyFlatRateDelivery : DEFAULT_RATES[region];
    }

    const patch = { rates };
    if (!shipRaw || shipRaw.pickupFee == null) patch.pickupFee = DEFAULT_PICKUP_FEE;
    // freeShippingThreshold stays whatever it is. It is NOT enabled here.
    if (!shipRaw || shipRaw.freeShippingThreshold === undefined) patch.freeShippingThreshold = null;

    console.log(`settings/shipping: ADD rates for [${missingRegions.join(', ')}] from ${source}`);
    console.log('  ' + JSON.stringify(patch));
    console.log('  (flatRateDelivery is NOT modified and NOT deleted)');
    writes.push({ ref: shipRef, patch, label: 'settings/shipping' });
  }

  /* ---------------- settings/payment ---------------- */
  const payPatch = {};
  if (!payRaw || payRaw.checkoutEnabled === undefined) {
    // Always false. This script can never turn a store live.
    payPatch.checkoutEnabled = false;
  }
  if (!payRaw || !payRaw.gcash) {
    payPatch.gcash = { enabled: false, accountName: '', mobileNumber: '', instructions: '', qrImagePath: null };
  }
  if (!payRaw || !payRaw.bank) {
    payPatch.bank = { enabled: false, bankName: '', accountName: '', accountNumber: '', instructions: '', qrImagePath: null };
  }

  if (Object.keys(payPatch).length === 0) {
    console.log('settings/payment: new-shape fields already present — no change.');
  } else {
    console.log('settings/payment: ADD ' + Object.keys(payPatch).join(', '));
    console.log('  ' + JSON.stringify(payPatch));
    console.log('  (methods[] is NOT modified and NOT deleted; checkoutEnabled written as false only)');
    writes.push({ ref: payRef, patch: payPatch, label: 'settings/payment' });
  }

  /* ---------------- execute ---------------- */
  if (!writes.length) {
    console.log('\nNothing to migrate. Already up to date.');
    process.exit(0);
  }

  if (dryRun) {
    console.log(`\nDRY RUN — ${writes.length} document(s) would be updated. Nothing was written.`);
    console.log('Re-run with --apply to perform the migration.');
    process.exit(0);
  }

  for (const w of writes) {
    // merge:true — purely additive, leaves every other key intact.
    // eslint-disable-next-line no-await-in-loop
    await w.ref.set({ ...w.patch, migratedAt: admin.firestore.FieldValue.serverTimestamp(), migratedBy: 'phase-5d2' }, { merge: true });
    console.log(`applied: ${w.label}`);
  }

  /* ---------------- immediate post-write verification ---------------- */
  console.log('\n=== Post-migration verification ===');
  const [shipAfter, payAfter] = await Promise.all([shipRef.get(), payRef.get()]);
  const shipN = normalizeShippingSettings(shipAfter.data());
  const payN = normalizePaymentSettings(payAfter.data());

  const checks = [
    ['shipping ratesSource is regional', shipN.ratesSource === 'regional'],
    ['legacy flatRateDelivery preserved', shipRaw && shipRaw.flatRateDelivery !== undefined ? shipAfter.data().flatRateDelivery === shipRaw.flatRateDelivery : true],
    ['legacy methods[] preserved', payRaw && payRaw.methods !== undefined ? JSON.stringify(payAfter.data().methods) === JSON.stringify(payRaw.methods) : true],
    ['checkoutEnabled is FALSE', payN.checkoutEnabled === false],
  ];
  let failed = 0;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? 'OK  ' : 'FAIL'}  ${label}`);
    if (!pass) failed++;
  }

  console.log(failed ? `\n${failed} check(s) FAILED — review before deploying.` : '\nMigration complete and verified.');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
