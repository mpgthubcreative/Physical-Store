/*
 * Scheduled function — runs every 5 minutes. Finds reservations that are
 * still `active` but past their `expiresAt`, and expires each one
 * transactionally via the exact same _shared/inventory.js logic
 * submit-payment.js uses for its own lazy expiration check — one
 * implementation of "what expiring a reservation means," not two.
 *
 * Each candidate reservation gets its OWN transaction that re-reads the
 * reservation and re-verifies it's still due before touching anything —
 * so if a customer submits payment (locking it) or another invocation
 * already expired it in the gap between this function's initial query and
 * that reservation's turn in the loop, expireReservationIfDue just
 * observes the non-active/not-yet-due status and no-ops. This is what
 * makes the sweep safe to run concurrently with itself or with a customer
 * request — never a double-release.
 */
const { schedule } = require('@netlify/functions');
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { expireReservationIfDue } = require('./_shared/inventory');

async function run() {
  const db = getDb();
  const now = admin.firestore.Timestamp.now();
  const snap = await db
    .collection('inventoryReservations')
    .where('status', '==', 'active')
    .where('expiresAt', '<', now)
    .get();

  console.log(`inventory-cleanup: found ${snap.size} reservation(s) past their expiry.`);

  let expiredCount = 0;
  for (const doc of snap.docs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await db.runTransaction(async (tx) => {
        const { expiredNow, orderPatch, reservation } = await expireReservationIfDue(tx, db, doc.ref, {
          actorType: 'system',
          actorId: 'scheduled-cleanup',
        });
        if (!expiredNow) return;
        tx.update(db.collection('orders').doc(reservation.orderId), {
          inventoryStatus: orderPatch.inventoryStatus,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          history: admin.firestore.FieldValue.arrayUnion(orderPatch.historyEntry),
        });
        expiredCount += 1;
      });
    } catch (err) {
      console.error(`inventory-cleanup: failed to expire reservation ${doc.id}:`, err);
    }
  }

  console.log(`inventory-cleanup: expired ${expiredCount} reservation(s).`);
}

exports.handler = schedule('*/5 * * * *', async () => {
  await run();
  return { statusCode: 200 };
});
