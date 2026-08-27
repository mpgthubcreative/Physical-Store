/*
 * ONE-TIME / RE-RUNNABLE LOCAL SCRIPT — writes settings/shipping and
 * settings/payment. These are configuration Firestore reads
 * (_shared/settings.js), not hard-coded values in any function or
 * frontend JS — edit the objects below with real values whenever you're
 * ready, then re-run this script. Safe to re-run: it's a plain .set() on
 * fixed doc IDs.
 *
 * Until this script has been run with real values, delivery stays
 * disabled (deliveryEnabled: false) and no payment method is shown to
 * customers (methods: []) — checkout intentionally cannot proceed with
 * delivery, and the payment page has nothing to display, until you fill
 * these in for real.
 *
 * Usage: node scripts/seed-settings.js
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

// ---- EDIT THESE WITH REAL VALUES WHEN READY ----

const SHIPPING = {
  deliveryEnabled: false, // flip to true once flatRateDelivery below is a real number
  flatRateDelivery: null, // e.g. 80 (pesos) — checkout refuses delivery while this is null
  freeShippingThreshold: null, // e.g. 1500 — orders at/above this subtotal ship free; leave null for no threshold
  pickupEnabled: true,
  pickupFee: 0,
};

const PAYMENT = {
  methods: [
    // Example shape — set enabled:true and fill in real details when ready:
    // { id: 'gcash', label: 'GCash', enabled: false, accountName: '', accountNumber: '', instructions: '' },
    // { id: 'bank_transfer', label: 'Bank Transfer', enabled: false, bankName: '', accountName: '', accountNumber: '', instructions: '' },
  ],
};

// -------------------------------------------------

async function main() {
  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();

  await db.collection('settings').doc('shipping').set(SHIPPING, { merge: true });
  await db.collection('settings').doc('payment').set(PAYMENT, { merge: true });

  console.log('Wrote settings/shipping and settings/payment.');
  console.log('shipping:', JSON.stringify(SHIPPING));
  console.log('payment:', JSON.stringify(PAYMENT));
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to seed settings:', err);
  process.exit(1);
});
