/*
 * POST /api/reserve-order
 *
 * PUBLIC — token-authenticated the same way get-order.js/submit-payment.js
 * are. Lets a customer whose reservation has expired try again: "Try to
 * reserve again" on order.html. Never automatic — this only ever runs in
 * direct response to that explicit customer action.
 *
 * Requires the order's reservation to currently be `expired` (via
 * _shared/inventory.js's reReserveExpired) and re-checks availability for
 * every originally-reserved resource, transactionally. If everything is
 * still available: expired -> active with a fresh 20-minute TTL. If not,
 * responds with a clear "still unavailable" result and reserves nothing —
 * never a partial reservation.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail, json } = require('./_shared/response');
const { requireString } = require('./_shared/validation');
const { resolveOrderByToken, TOKEN_FIELD_MAX_LENGTH } = require('./_shared/orderTokenAuth');
const { reReserveExpired, InsufficientStockError, ReservationConflictError } = require('./_shared/inventory');

const RESERVE_ALLOWED_FROM = ['awaiting_payment', 'rejected'];

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const body = JSON.parse(event.body || '{}');
  const db = getDb();

  const token = requireString(body.token, 'token', { maxLength: TOKEN_FIELD_MAX_LENGTH });

  let result;
  try {
    result = await db.runTransaction(async (tx) => {
      const resolved = await resolveOrderByToken(db, token, 'reservation:retry', { tx });
      if (!resolved.ok) return { ok: false, status: 404, error: 'Order not found.' };
      const { doc, order } = resolved;

      if (order.isTest === true) return { ok: false, status: 400, error: 'Not applicable for this order.' };
      if (!RESERVE_ALLOWED_FROM.includes(order.paymentStatus)) {
        return { ok: false, status: 400, error: `Cannot re-reserve — order is currently "${order.paymentStatus}".` };
      }

      const reservationRef = db.collection('inventoryReservations').doc(doc.id);
      const { orderPatch } = await reReserveExpired(tx, db, reservationRef, { actorType: 'customer' });

      tx.update(doc.ref, {
        inventoryStatus: orderPatch.inventoryStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        history: admin.firestore.FieldValue.arrayUnion(orderPatch.historyEntry),
      });

      return { ok: true };
    });
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return json(409, { error: 'STILL_UNAVAILABLE', message: 'Sorry — part of your order is no longer available in the quantity you ordered.' });
    }
    if (err instanceof ReservationConflictError) {
      if (err.reason === 'NOT_EXPIRED') {
        return json(409, { error: 'NOT_EXPIRED', message: 'Your reservation is still active — no need to reserve again.' });
      }
      return fail(409, 'This order is not in a state that can be re-reserved.');
    }
    throw err;
  }

  if (!result.ok) return fail(result.status, result.error);
  return ok({ reserved: true });
});
