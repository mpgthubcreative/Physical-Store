/*
 * ONE-TIME LOCAL SCRIPT — strictly READ-ONLY Phase 5D pre-deployment
 * verification. Performs no Firestore .set()/.update()/.delete()/
 * transactions, no Storage operations, and no other state-mutating calls
 * of any kind — every Firestore call in this file is a .get().
 *
 * Two checks:
 *   1. Reads order BP-73G5WW and its corresponding inventoryReservations
 *      document, and prints their current state for manual review before
 *      deploying Phase 5D.
 *   2. Reads every order in the explicit Phase 5D QA allowlist (the same
 *      list scripts/mark-phase5d-qa-orders-as-test.js used) and confirms
 *      each one now has isTest:true, reporting any that don't.
 *
 * Never prints the service-account JSON, any private key material, a
 * Firebase ID token, or a customer's raw order-access token — only
 * business-level order/reservation fields.
 *
 * Usage: node scripts/verify-phase5d-predeploy.js
 * Credentials: FIREBASE_SERVICE_ACCOUNT_JSON environment variable only
 * (no serviceAccountKey.json fallback for this script — set it in your
 * own shell before running).
 */
const admin = require('firebase-admin');

function loadServiceAccount() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.error('FIREBASE_SERVICE_ACCOUNT_JSON is not set in this shell. Set it before running this script.');
    process.exit(1);
  }
  try {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    console.error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    process.exit(1);
  }
}

const TARGET_ORDER_NUMBER = 'BP-73G5WW';

// Same explicit allowlist as scripts/mark-phase5d-qa-orders-as-test.js.
const QA_ORDER_NUMBERS = [
  'BP-9G4AHQ',
  'BP-WCFKCM',
  'BP-3UVN5E',
  'BP-VJZMV6',
  'BP-TJEN4Z',
  'BP-TELWWZ',
  'BP-64D7Q2',
  'BP-33GJMV',
  'BP-4QS778',
  'BP-4AGDFW',
  'BP-VDJPHE',
  'BP-GK94S3',
];

function fmtTimestamp(ts) {
  if (!ts) return null;
  const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  return date.toISOString();
}

function summarizeResources(resources) {
  const variants = (resources || []).filter((r) => r.type === 'variant').map((r) => ({ productId: r.productId, variantId: r.variantId, quantity: r.quantity }));
  const patches = (resources || []).filter((r) => r.type === 'patch').map((r) => ({ patchId: r.patchId, quantity: r.quantity }));
  return { variants, patches };
}

async function main() {
  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();

  console.log('=== Firebase project check ===');
  console.log(`project_id: ${serviceAccount.project_id}`);
  if (serviceAccount.project_id !== 'buddy-shop-45fc4') {
    console.warn(`WARNING: expected project_id "buddy-shop-45fc4", got "${serviceAccount.project_id}".`);
  }

  console.log(`\n=== Order ${TARGET_ORDER_NUMBER} (read-only) ===`);
  const orderSnap = await db.collection('orders').where('orderNumber', '==', TARGET_ORDER_NUMBER).limit(1).get();
  if (orderSnap.empty) {
    console.log(`Order ${TARGET_ORDER_NUMBER} not found.`);
  } else {
    const doc = orderSnap.docs[0];
    const order = doc.data();
    console.log(`orderNumber: ${order.orderNumber}`);
    console.log(`customerName: ${order.customerName}`);
    console.log(`customerEmail: ${order.customerEmail}`);
    console.log(`paymentStatus: ${order.paymentStatus}`);
    console.log(`fulfillmentStatus: ${order.fulfillmentStatus}`);
    console.log(`inventoryStatus: ${order.inventoryStatus || null}`);
    console.log(`isTest: ${order.isTest === true}`);

    const reservationSnap = await db.collection('inventoryReservations').doc(doc.id).get();
    if (!reservationSnap.exists) {
      console.log('\ninventoryReservations doc: NOT FOUND for this order.');
    } else {
      const reservation = reservationSnap.data();
      const { variants, patches } = summarizeResources(reservation.resources);
      console.log('\n--- inventoryReservations/' + doc.id + ' ---');
      console.log(`status: ${reservation.status}`);
      console.log(`expiresAt: ${fmtTimestamp(reservation.expiresAt)}`);
      console.log(`createdAt: ${fmtTimestamp(reservation.createdAt)}`);
      console.log(`updatedAt: ${fmtTimestamp(reservation.updatedAt)}`);
      console.log('reserved variant resources:', JSON.stringify(variants));
      console.log('reserved patch resources:', JSON.stringify(patches));
    }
  }

  console.log('\n=== Phase 5D QA orders: isTest:true check (read-only) ===');
  const missing = [];
  const notFound = [];
  for (const orderNumber of QA_ORDER_NUMBERS) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collection('orders').where('orderNumber', '==', orderNumber).limit(1).get();
    if (snap.empty) {
      notFound.push(orderNumber);
      continue;
    }
    const isTest = snap.docs[0].data().isTest === true;
    console.log(`${orderNumber}: isTest=${isTest}`);
    if (!isTest) missing.push(orderNumber);
  }

  if (missing.length) {
    console.warn(`\nWARNING: these QA orders do NOT have isTest:true: ${missing.join(', ')}`);
  } else {
    console.log('\nAll QA orders in the allowlist have isTest:true.');
  }
  if (notFound.length) {
    console.warn(`WARNING: these QA order numbers were not found: ${notFound.join(', ')}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Verification script failed:', err);
  process.exit(1);
});
