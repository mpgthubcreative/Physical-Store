/*
 * Centralized inventory-sensitive logic — demand aggregation, availability
 * validation, and the reserve/release/consume Firestore mutations. Every
 * endpoint that touches reservedQty/stockQty (create-order, submit-payment,
 * admin-approve-payment, admin-reject-payment, the re-reservation endpoint,
 * and the scheduled cleanup function) goes through this module rather than
 * reimplementing the math — so there is exactly one place that decides
 * what "enough stock" means and exactly one place that mutates it.
 *
 * ---- Aggregate-by-document, not aggregate-by-line ----
 * Multiple variants of the SAME product live inside one products/{id} doc.
 * An order can easily demand two different variants of the same product
 * (or the same patch used by two different lines). Every function here
 * reads each distinct product/patch document EXACTLY ONCE per call,
 * computes every affected variant's new value in memory against that
 * single read, and writes the document EXACTLY ONCE — never issuing two
 * sequential tx.update() calls against the same doc with two different
 * stale copies of its variants array (the second would silently discard
 * the first's change).
 *
 * ---- Fail closed on missing reservedQty ----
 * A variant/patch that somehow lacks a reservedQty field (pre-migration,
 * or a bug) is treated as if reservedQty === stockQty — i.e. availableQty
 * = 0 — never as reservedQty === 0 (which would read as "fully
 * available"/unlimited). Unknown reservation state must never be read as
 * "definitely available."
 */
const { admin } = require('./firebaseAdmin');

const RESERVATION_TTL_MS = 20 * 60 * 1000; // 20 minutes

class InsufficientStockError extends Error {
  constructor(detail) {
    super(`Insufficient stock: ${JSON.stringify(detail)}`);
    this.name = 'InsufficientStockError';
    this.detail = detail; // { type: 'variant'|'patch', productId?, variantId?, patchId?, reason }
  }
}

function safeQty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Missing reservedQty fails closed: treated as fully reserved (availableQty = 0), never as unreserved/unlimited. */
function safeReservedQty(record) {
  const n = Number(record.reservedQty);
  if (Number.isFinite(n)) return n;
  return safeQty(record.stockQty);
}

function availableQty(record) {
  return safeQty(record.stockQty) - safeReservedQty(record);
}

/**
 * Aggregates demand across an ENTIRE array of order-line snapshots (the
 * same shape create-order.js builds and stores as order.items — also
 * reusable at re-reservation time directly against the order's own
 * immutable stored items[], never against live cart input again).
 *
 * Two lines using the same variant, or a patch used many times across
 * different lines, are summed here — this is the single implementation of
 * that aggregation Phase 5C proved out and Phase 5D now feeds directly
 * into the reservation transaction.
 */
function aggregateDemandFromLines(lines) {
  const variantDemand = new Map(); // `${productId}::${variantId}` -> qty
  const patchDemand = new Map(); // patchId -> qty
  for (const line of lines || []) {
    const vKey = `${line.productId}::${line.variantId}`;
    variantDemand.set(vKey, (variantDemand.get(vKey) || 0) + line.quantity);
    if (line.customization) {
      for (const p of line.customization.patches || []) {
        patchDemand.set(p.patchId, (patchDemand.get(p.patchId) || 0) + line.quantity);
      }
    }
  }
  return { variantDemand, patchDemand };
}

/** Converts the two demand Maps into the flat `resources[]` shape stored on inventoryReservations/{orderId}. */
function resourcesFromDemand(variantDemand, patchDemand) {
  const resources = [];
  for (const [key, quantity] of variantDemand) {
    const [productId, variantId] = key.split('::');
    resources.push({ type: 'variant', productId, variantId, quantity });
  }
  for (const [patchId, quantity] of patchDemand) {
    resources.push({ type: 'patch', patchId, quantity });
  }
  return resources;
}

/** Reads every distinct product/patch doc referenced by `resources`, exactly once each, via tx.get(). No validation, no writes. */
async function readInventoryDocs(tx, db, resources) {
  const productIds = [...new Set(resources.filter((r) => r.type === 'variant').map((r) => r.productId))];
  const patchIds = [...new Set(resources.filter((r) => r.type === 'patch').map((r) => r.patchId))];

  const productDocs = new Map();
  for (const id of productIds) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await tx.get(db.collection('products').doc(id));
    productDocs.set(id, snap.exists ? { ref: snap.ref, data: snap.data() } : null);
  }
  const patchDocs = new Map();
  for (const id of patchIds) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await tx.get(db.collection('patches').doc(id));
    patchDocs.set(id, snap.exists ? { ref: snap.ref, data: snap.data() } : null);
  }
  return { productDocs, patchDocs };
}

/** Same as readInventoryDocs, but throws InsufficientStockError if any resource doesn't exist or availableQty < demand. */
async function readAndValidateAvailability(tx, db, resources) {
  const { productDocs, patchDocs } = await readInventoryDocs(tx, db, resources);

  for (const r of resources) {
    if (r.type === 'variant') {
      const entry = productDocs.get(r.productId);
      if (!entry) throw new InsufficientStockError({ type: 'variant', productId: r.productId, variantId: r.variantId, reason: 'PRODUCT_NOT_FOUND' });
      const variant = (entry.data.variants || []).find((v) => v.variantId === r.variantId);
      if (!variant) throw new InsufficientStockError({ type: 'variant', productId: r.productId, variantId: r.variantId, reason: 'VARIANT_NOT_FOUND' });
      if (availableQty(variant) < r.quantity) {
        throw new InsufficientStockError({ type: 'variant', productId: r.productId, variantId: r.variantId, reason: 'OUT_OF_STOCK' });
      }
    } else {
      const entry = patchDocs.get(r.patchId);
      if (!entry) throw new InsufficientStockError({ type: 'patch', patchId: r.patchId, reason: 'PATCH_NOT_FOUND' });
      if (availableQty(entry.data) < r.quantity) {
        throw new InsufficientStockError({ type: 'patch', patchId: r.patchId, reason: 'OUT_OF_STOCK' });
      }
    }
  }

  return { productDocs, patchDocs };
}

/** Applies delta*quantity to reservedQty for every resource (delta=+1 reserve, delta=-1 release), one write per distinct document. */
function applyReservedQtyDelta(tx, { productDocs, patchDocs }, resources, delta) {
  const variantResourcesByProduct = new Map();
  for (const r of resources.filter((r) => r.type === 'variant')) {
    if (!variantResourcesByProduct.has(r.productId)) variantResourcesByProduct.set(r.productId, []);
    variantResourcesByProduct.get(r.productId).push(r);
  }

  for (const [productId, variantResources] of variantResourcesByProduct) {
    const entry = productDocs.get(productId);
    if (!entry) throw new Error(`applyReservedQtyDelta: product ${productId} was not read.`);
    const updatedVariants = (entry.data.variants || []).map((v) => {
      const match = variantResources.find((r) => r.variantId === v.variantId);
      if (!match) return v;
      const next = safeReservedQty(v) + delta * match.quantity;
      if (next < 0) throw new Error(`reservedQty would go negative for variant ${v.variantId} on product ${productId}.`);
      return { ...v, reservedQty: next };
    });
    tx.update(entry.ref, { variants: updatedVariants });
  }

  for (const r of resources.filter((r) => r.type === 'patch')) {
    const entry = patchDocs.get(r.patchId);
    if (!entry) throw new Error(`applyReservedQtyDelta: patch ${r.patchId} was not read.`);
    const next = safeReservedQty(entry.data) + delta * r.quantity;
    if (next < 0) throw new Error(`reservedQty would go negative for patch ${r.patchId}.`);
    tx.update(entry.ref, { reservedQty: next });
  }
}

/** Payment approval only: decrements BOTH stockQty and reservedQty together (permanent commit), one write per distinct document. */
function applyConsumption(tx, { productDocs, patchDocs }, resources) {
  const variantResourcesByProduct = new Map();
  for (const r of resources.filter((r) => r.type === 'variant')) {
    if (!variantResourcesByProduct.has(r.productId)) variantResourcesByProduct.set(r.productId, []);
    variantResourcesByProduct.get(r.productId).push(r);
  }

  for (const [productId, variantResources] of variantResourcesByProduct) {
    const entry = productDocs.get(productId);
    if (!entry) throw new Error(`applyConsumption: product ${productId} was not read.`);
    const updatedVariants = (entry.data.variants || []).map((v) => {
      const match = variantResources.find((r) => r.variantId === v.variantId);
      if (!match) return v;
      const nextStock = safeQty(v.stockQty) - match.quantity;
      const nextReserved = safeReservedQty(v) - match.quantity;
      if (nextStock < 0 || nextReserved < 0) throw new Error(`Consumption would go negative for variant ${v.variantId} on product ${productId}.`);
      return { ...v, stockQty: nextStock, reservedQty: nextReserved };
    });
    tx.update(entry.ref, { variants: updatedVariants });
  }

  for (const r of resources.filter((r) => r.type === 'patch')) {
    const entry = patchDocs.get(r.patchId);
    if (!entry) throw new Error(`applyConsumption: patch ${r.patchId} was not read.`);
    const nextStock = safeQty(entry.data.stockQty) - r.quantity;
    const nextReserved = safeReservedQty(entry.data) - r.quantity;
    if (nextStock < 0 || nextReserved < 0) throw new Error(`Consumption would go negative for patch ${r.patchId}.`);
    tx.update(entry.ref, { stockQty: nextStock, reservedQty: nextReserved });
  }
}

/** New reservation only — validates availability, throws InsufficientStockError if anything is short, otherwise reserves everything. */
async function reserveInventory(tx, db, resources) {
  const docs = await readAndValidateAvailability(tx, db, resources);
  applyReservedQtyDelta(tx, docs, resources, 1);
}

/** Releases a reservation's hold (expiry) — no availability check, just gives the units back. */
async function releaseInventory(tx, db, resources) {
  const docs = await readInventoryDocs(tx, db, resources);
  applyReservedQtyDelta(tx, docs, resources, -1);
}

/** Payment approval — permanently commits a locked reservation's units. */
async function consumeInventory(tx, db, resources) {
  const docs = await readInventoryDocs(tx, db, resources);
  applyConsumption(tx, docs, resources);
}

function freshExpiry(now) {
  return admin.firestore.Timestamp.fromMillis(now.toMillis() + RESERVATION_TTL_MS);
}

/*
 * ---- Reservation-document lifecycle ----
 * Everything below composes the primitives above into the named state
 * transitions Phase 5D's architecture defines (active/locked/consumed/
 * expired/released). Each endpoint (create-order, submit-payment,
 * admin-approve-payment, admin-reject-payment, reserve-order, the scheduled
 * cleanup function) calls these rather than hand-rolling the transition —
 * so there is exactly one implementation of what "lock a reservation" or
 * "consume a reservation" means.
 *
 * IMPORTANT: none of these write to the `orders` collection. A Firestore
 * transaction may contain at most ONE write per document — and several
 * callers (submit-payment.js, admin-approve-payment.js,
 * admin-reject-payment.js) already need their own single write to the
 * order doc in the same transaction (payment status/attempts). So each
 * function here only ever writes the reservation document, and returns an
 * `orderPatch` object ({ inventoryStatus, historyEntry }) describing what
 * the CALLER must fold into its own single `tx.update(orderRef, ...)`.
 * `historyEntry` is a plain object meant to be wrapped in
 * `admin.firestore.FieldValue.arrayUnion(...)` by the caller.
 */

class ReservationConflictError extends Error {
  constructor(reason, detail) {
    super(`Reservation conflict: ${reason}`);
    this.name = 'ReservationConflictError';
    this.reason = reason; // 'NOT_ACTIVE' | 'NOT_LOCKED' | 'NOT_EXPIRED' | 'ALREADY_PROCESSED'
    this.detail = detail || null;
  }
}

function reservationHistoryEntry(action, now, actor) {
  return { action, at: now, actorType: (actor && actor.actorType) || 'system', actorId: (actor && actor.actorId) || null, meta: (actor && actor.meta) || {} };
}

/**
 * Reads a reservation; if it's `active` and its TTL has passed, releases its
 * held inventory and flips the reservation to `expired`, transactionally.
 * A reservation already in any other status is left untouched and returned
 * as-is — so two callers racing to lazily-expire the same reservation (e.g.
 * the scheduled sweep and a customer's own submit-payment request) can
 * never double-release it: whichever runs second just observes a
 * non-active status and no-ops. Used by submit-payment.js (reject stale
 * payment attempts) and the scheduled cleanup function (bulk sweep) — both
 * are responsible for applying the returned `orderPatch` (when non-null) to
 * the order themselves.
 */
async function expireReservationIfDue(tx, db, reservationRef, actor) {
  const snap = await tx.get(reservationRef);
  if (!snap.exists) throw new Error(`Reservation ${reservationRef.id} not found.`);
  const reservation = snap.data();
  if (reservation.status !== 'active') return { reservation, expiredNow: false, orderPatch: null };

  const now = admin.firestore.Timestamp.now();
  const dueMs = reservation.expiresAt ? reservation.expiresAt.toMillis() : 0;
  if (dueMs > now.toMillis()) return { reservation, expiredNow: false, orderPatch: null };

  await releaseInventory(tx, db, reservation.resources);
  tx.update(reservationRef, {
    status: 'expired',
    updatedAt: now,
    history: admin.firestore.FieldValue.arrayUnion(reservationHistoryEntry('expired', now, actor)),
  });
  return {
    reservation: { ...reservation, status: 'expired' },
    expiredNow: true,
    orderPatch: { inventoryStatus: 'expired', historyEntry: reservationHistoryEntry('inventory_expired', now, actor) },
  };
}

/** active -> locked. Caller must already know the reservation is active (e.g. via expireReservationIfDue). No inventory quantity change — locking only changes status and clears automatic expiration. Returns the orderPatch the caller must fold into its own order write. */
function lockReservation(tx, reservationRef, actor) {
  const now = admin.firestore.Timestamp.now();
  tx.update(reservationRef, {
    status: 'locked',
    updatedAt: now,
    history: admin.firestore.FieldValue.arrayUnion(reservationHistoryEntry('locked', now, actor)),
  });
  return { orderPatch: { inventoryStatus: 'locked', historyEntry: reservationHistoryEntry('inventory_locked', now, actor) } };
}

/**
 * locked -> active with a fresh TTL, on payment rejection. Reservation
 * stays held (reservedQty untouched) — the customer gets a fresh
 * correction window rather than losing their spot. Unlike lockReservation
 * (whose caller already re-confirmed `active` via a read earlier in the
 * SAME transaction attempt), this endpoint's only prior signal is
 * order.paymentStatus === 'pending_review' on a different document — so
 * this reads the reservation itself and throws
 * ReservationConflictError('NOT_LOCKED') if it isn't actually `locked`,
 * rather than blindly overwriting whatever state it's in. Returns the
 * orderPatch the caller must fold into its own order write.
 */
async function reactivateReservation(tx, db, reservationRef, actor) {
  const snap = await tx.get(reservationRef);
  if (!snap.exists) throw new Error(`Reservation ${reservationRef.id} not found.`);
  const reservation = snap.data();
  if (reservation.status !== 'locked') {
    throw new ReservationConflictError('NOT_LOCKED', { status: reservation.status });
  }

  const now = admin.firestore.Timestamp.now();
  tx.update(reservationRef, {
    status: 'active',
    expiresAt: freshExpiry(now),
    updatedAt: now,
    history: admin.firestore.FieldValue.arrayUnion(reservationHistoryEntry('reactivated', now, actor)),
  });
  return { orderPatch: { inventoryStatus: 'reserved', historyEntry: reservationHistoryEntry('inventory_reserved', now, actor) } };
}

/**
 * locked -> consumed, on payment approval. Permanently commits the
 * reservation's units (stockQty AND reservedQty both decrement together).
 * Idempotent by construction: reads the reservation itself and throws
 * ReservationConflictError('ALREADY_PROCESSED') if it is not currently
 * `locked` — a retried/double-clicked approval hits this guard before ever
 * touching inventory a second time, since the first successful call already
 * moved the reservation to `consumed`. Returns the orderPatch the caller
 * must fold into its own order write.
 */
async function consumeReservation(tx, db, reservationRef, actor) {
  const snap = await tx.get(reservationRef);
  if (!snap.exists) throw new Error(`Reservation ${reservationRef.id} not found.`);
  const reservation = snap.data();
  if (reservation.status !== 'locked') {
    throw new ReservationConflictError('ALREADY_PROCESSED', { status: reservation.status });
  }

  await consumeInventory(tx, db, reservation.resources);
  const now = admin.firestore.Timestamp.now();
  tx.update(reservationRef, {
    status: 'consumed',
    updatedAt: now,
    history: admin.firestore.FieldValue.arrayUnion(reservationHistoryEntry('consumed', now, actor)),
  });
  return { orderPatch: { inventoryStatus: 'consumed', historyEntry: reservationHistoryEntry('inventory_consumed', now, actor) } };
}

/**
 * Customer-triggered re-reservation only: expired -> active with a fresh
 * TTL, and ONLY if every originally-reserved resource is available again
 * right now. Reuses the reservation's own frozen `resources` (identical to
 * what was demanded at order creation — order.items never changes) rather
 * than recomputing demand. Throws InsufficientStockError if anything is
 * still short — never partially re-reserves. Returns the orderPatch the
 * caller must fold into its own order write.
 */
async function reReserveExpired(tx, db, reservationRef, actor) {
  const snap = await tx.get(reservationRef);
  if (!snap.exists) throw new Error(`Reservation ${reservationRef.id} not found.`);
  const reservation = snap.data();
  if (reservation.status !== 'expired') {
    throw new ReservationConflictError('NOT_EXPIRED', { status: reservation.status });
  }

  await reserveInventory(tx, db, reservation.resources);
  const now = admin.firestore.Timestamp.now();
  tx.update(reservationRef, {
    status: 'active',
    expiresAt: freshExpiry(now),
    updatedAt: now,
    history: admin.firestore.FieldValue.arrayUnion(reservationHistoryEntry('re_reserved', now, actor)),
  });
  return { orderPatch: { inventoryStatus: 'reserved', historyEntry: reservationHistoryEntry('inventory_reserved', now, actor) } };
}

module.exports = {
  RESERVATION_TTL_MS,
  InsufficientStockError,
  ReservationConflictError,
  safeQty,
  safeReservedQty,
  availableQty,
  aggregateDemandFromLines,
  resourcesFromDemand,
  readInventoryDocs,
  readAndValidateAvailability,
  reserveInventory,
  releaseInventory,
  consumeInventory,
  freshExpiry,
  expireReservationIfDue,
  lockReservation,
  reactivateReservation,
  consumeReservation,
  reReserveExpired,
};
