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
//
// Phase 5D.2 note: these are now editable from Admin -> Settings, which is
// the normal way to change them. This script remains useful only for
// bootstrapping a fresh project from a shell.
//
// Both objects are written with { merge: true }, so any key NOT listed here
// (including the pre-5D.2 `flatRateDelivery` and `methods[]`) is left
// untouched on the existing document.

const SHIPPING = {
  deliveryEnabled: false, // flip to true once the rates below are real numbers
  pickupEnabled: true,
  pickupFee: 0,
  // Approved Phase 5D.2 V1 defaults. A region left null cannot be delivered
  // to — it is refused at checkout, never shipped free.
  rates: {
    luzon: 150,
    visayas: 180,
    mindanao: 200,
  },
  freeShippingThreshold: null, // e.g. 1500 — delivery is free once the ITEMS subtotal reaches this; null disables the rule
};

const PAYMENT = {
  // MASTER SWITCH. While false, create-order.js refuses every order,
  // server-side, no matter what else is configured. Leave this false until
  // real payment details are in and activation is explicitly approved.
  checkoutEnabled: false,

  gcash: {
    enabled: false,
    accountName: '', // e.g. 'Juan D.'
    mobileNumber: '', // e.g. '0917 123 4567'
    instructions: '',
    // qrImagePath is managed by the Admin -> Settings upload flow, not here.
  },
  bank: {
    enabled: false,
    bankName: '', // e.g. 'BPI'
    accountName: '',
    accountNumber: '',
    instructions: '',
  },
};

// -------------------------------------------------

async function main() {
  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();

  // Refuse to silently flip the store live from a script — activation is an
  // explicit Owner action in Admin -> Settings, with a confirmation.
  if (PAYMENT.checkoutEnabled === true) {
    console.error('Refusing to run: checkoutEnabled is true in this script. Activate checkout from Admin -> Settings instead.');
    process.exit(1);
  }

  await db.collection('settings').doc('shipping').set(SHIPPING, { merge: true });
  await db.collection('settings').doc('payment').set(PAYMENT, { merge: true });

  console.log('Wrote settings/shipping and settings/payment (merge — legacy fields preserved).');
  console.log('shipping:', JSON.stringify(SHIPPING));
  console.log('payment:', JSON.stringify(PAYMENT));
  console.log('\ncheckoutEnabled is false — the store cannot take orders until you enable it in Admin -> Settings.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to seed settings:', err);
  process.exit(1);
});
