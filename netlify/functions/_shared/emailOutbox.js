/*
 * The transactional outbox: enqueueEmail() is the ONE function every
 * commerce endpoint calls to durably record "this email needs to be sent",
 * and it is the ONLY place that decides deterministic IDs, token scopes,
 * TTLs, and suppression. Nothing here ever calls Resend — see
 * process-email-outbox.js for the separate, later, scheduled sender.
 *
 * ---- The core guarantee ----
 * Callers pass the SAME Firestore transaction (`tx`) already open for
 * their business-state write. enqueueEmail() adds exactly one more
 * tx.set() to that transaction. If the transaction fails to commit for ANY
 * reason, neither the business state change nor the email event commits —
 * they succeed or fail together, atomically. That is the actual guarantee
 * ("no email event without a real state change, no state change without a
 * durable event"), not "the outbox write can't affect the transaction" —
 * it is fully part of it. What a failing Resend call can NEVER do is roll
 * back commerce state, because it never runs inside this transaction, or
 * inside ANY commerce-changing request — only later, inside the separate
 * scheduled processor.
 *
 * ---- isTest and email mode are both resolved HERE, at enqueue time ----
 * A suppressed status (suppressed_test / suppressed_disabled) is written
 * immediately and is PERMANENTLY terminal — process-email-outbox.js's
 * queries never select either status, so there is no code path, now or
 * later, that could resurrect a suppressed event. Turning email mode on
 * only ever affects events created AFTER that change.
 */

// ---- Deterministic event vocabulary ----
// Every key here is a known email type. `scopes: null` means the email
// carries no order link (the admin/inquiry notifications).
const EMAIL_TYPES = {
  'order-created': { scopes: ['order:read', 'payment:submit'] },
  'payment-submitted': { scopes: ['order:read'] },
  'payment-rejected': { scopes: ['order:read', 'payment:submit', 'reservation:retry'] },
  'payment-approved': { scopes: ['order:read'] },
  'reservation-expired': { scopes: ['order:read', 'reservation:retry'] },
  'fulfillment-processing': { scopes: ['order:read'] },
  'fulfillment-ready': { scopes: ['order:read'] },
  'fulfillment-shipped': { scopes: ['order:read'] },
  'fulfillment-completed': { scopes: ['order:read'] },
  'order-admin-new': { scopes: null },
  'payment-admin-review': { scopes: null },
  'event-inquiry-admin': { scopes: null },
  'event-inquiry-customer': { scopes: null },
};

// Scopes that grant a state-changing action get the shorter TTL; a pure
// read-only link gets a longer one, since referring back to "your order
// shipped" months later is low-risk and genuinely useful.
const ACTION_SCOPES = new Set(['payment:submit', 'reservation:retry']);
const READ_ONLY_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
const ACTION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function ttlForScopes(scopes) {
  return scopes.some((s) => ACTION_SCOPES.has(s)) ? ACTION_TTL_MS : READ_ONLY_TTL_MS;
}

/**
 * Deterministic outbox document ID.
 *
 * Firestore forbids IDs that both start AND end with "__" (reserved for
 * internal use) — none of these do, since every id starts with a plain
 * word character. Safe to use directly as a document ID with no further
 * encoding: types are fixed ASCII, orderId/inquiryId are Firestore
 * auto-IDs, attemptId is already constrained to [A-Za-z0-9-]{8,100} by
 * orderSecurity.js's isValidIdempotencyKey, and numeric discriminators are
 * plain digit strings.
 */
function buildOutboxId(type, idParts) {
  if (!EMAIL_TYPES[type]) throw new Error(`Unknown email type "${type}".`);
  return [type, ...idParts].join('__');
}

/**
 * Resolves the recipient this event will actually be sent to, and the
 * status it starts in — the single place that answers "does this email
 * actually go out, and to whom."
 *
 * Precedence, most restrictive first:
 *   1. isTest:true            -> suppressed_test, unconditionally
 *   2. mode === 'off'         -> suppressed_disabled
 *   3. mode === 'qa'
 *        no override configured -> suppressed_disabled (FAIL SAFE: never
 *          fall through to a real address just because the QA override
 *          env var went missing after the mode was set)
 *        override configured    -> pending, sent only to that address
 *   4. mode === 'live'        -> pending, sent to the real recipient
 */
function resolveDelivery({ isTestOrder, mode, intendedRecipientEmail }) {
  if (isTestOrder) {
    return { status: 'suppressed_test', effectiveRecipientEmail: intendedRecipientEmail };
  }
  if (mode === 'off') {
    return { status: 'suppressed_disabled', effectiveRecipientEmail: intendedRecipientEmail };
  }
  if (mode === 'qa') {
    const override = (process.env.EMAIL_QA_OVERRIDE_RECIPIENT || '').trim();
    if (!override) {
      return { status: 'suppressed_disabled', effectiveRecipientEmail: intendedRecipientEmail };
    }
    return { status: 'pending', effectiveRecipientEmail: override };
  }
  // mode === 'live'
  return { status: 'pending', effectiveRecipientEmail: intendedRecipientEmail };
}

/**
 * Enqueues one durable email event inside the caller's already-open
 * transaction.
 *
 * @param tx               the caller's Firestore transaction
 * @param db               Firestore instance (for building the doc ref)
 * @param type              one of EMAIL_TYPES' keys
 * @param idParts          array of discriminator strings for the deterministic ID
 * @param orderId          or null for inquiry-only events
 * @param inquiryId        or null for order events
 * @param intendedRecipientEmail  the REAL recipient — snapshotted, never re-derived later
 * @param payload          template data only — must never contain a raw token
 * @param isTestOrder      the order's own isTest flag (or false for non-order events)
 * @param emailSettings    { mode } from _shared/emailSettings.js, read earlier in this same transaction
 * @param now              admin.firestore.Timestamp.now(), the caller's own transaction-local clock read
 *
 * Snapshots EVERYTHING the processor needs to build and send the exact
 * same request on every retry — including fromAddress/siteBaseUrl/mode —
 * so a later change to EMAIL_FROM, SITE_URL, or the mode itself can never
 * alter what an already-enqueued event sends.
 */
function enqueueEmail(tx, db, { type, idParts, orderId = null, inquiryId = null, intendedRecipientEmail, payload, isTestOrder = false, emailSettings, now }) {
  const def = EMAIL_TYPES[type];
  if (!def) throw new Error(`Unknown email type "${type}".`);
  if (!intendedRecipientEmail) throw new Error(`enqueueEmail(${type}): intendedRecipientEmail is required.`);
  if (!emailSettings || typeof emailSettings.mode !== 'string') throw new Error(`enqueueEmail(${type}): emailSettings.mode is required.`);
  if (!now || typeof now.toMillis !== 'function') throw new Error(`enqueueEmail(${type}): now must be a Firestore Timestamp.`);

  const outboxId = buildOutboxId(type, idParts);
  const ref = db.collection('emailOutbox').doc(outboxId);

  const { status, effectiveRecipientEmail } = resolveDelivery({
    isTestOrder,
    mode: emailSettings.mode,
    intendedRecipientEmail,
  });

  const tokenClaims = def.scopes
    ? { sc: def.scopes, iat: now.toMillis(), exp: now.toMillis() + ttlForScopes(def.scopes) }
    : null;

  tx.set(ref, {
    type,
    orderId,
    inquiryId,

    // ---- Delivery snapshot (Phase 5E correction: every non-secret input
    // the processor needs, frozen now, never re-read from mutable
    // env/config at send time) ----
    intendedRecipientEmail,
    effectiveRecipientEmail,
    emailModeAtEnqueue: emailSettings.mode,
    fromAddress: process.env.EMAIL_FROM || null,
    siteBaseUrl: process.env.SITE_URL || null,
    templateType: type,
    templateVersion: 1,
    payload,
    tokenClaims,

    // ---- Lifecycle state ----
    status,
    attempts: 0,
    nextAttemptAt: now,
    processingStartedAt: null,
    leaseExpiresAt: null,
    firstSendAttemptAt: null,
    lastError: null,
    resendMessageId: null,
    createdAt: now,
    sentAt: null,
  });

  return { outboxId, status };
}

/*
 * ---- Thin per-event wrappers ----
 * Centralize the idParts scheme so call sites never hand-build a
 * deterministic ID themselves — one place decides the ID shape for each
 * event, matching the locked lifecycle map exactly.
 */

function enqueueOrderCreated(tx, db, { orderId, recipientEmail, payload, isTestOrder, emailSettings, now }) {
  return enqueueEmail(tx, db, { type: 'order-created', idParts: [orderId], orderId, intendedRecipientEmail: recipientEmail, payload, isTestOrder, emailSettings, now });
}

function enqueuePaymentSubmitted(tx, db, { orderId, attemptId, recipientEmail, payload, isTestOrder, emailSettings, now }) {
  return enqueueEmail(tx, db, { type: 'payment-submitted', idParts: [orderId, attemptId], orderId, intendedRecipientEmail: recipientEmail, payload, isTestOrder, emailSettings, now });
}

function enqueuePaymentRejected(tx, db, { orderId, attemptId, recipientEmail, payload, isTestOrder, emailSettings, now }) {
  return enqueueEmail(tx, db, { type: 'payment-rejected', idParts: [orderId, attemptId], orderId, intendedRecipientEmail: recipientEmail, payload, isTestOrder, emailSettings, now });
}

function enqueuePaymentApproved(tx, db, { orderId, attemptId, recipientEmail, payload, isTestOrder, emailSettings, now }) {
  return enqueueEmail(tx, db, { type: 'payment-approved', idParts: [orderId, attemptId], orderId, intendedRecipientEmail: recipientEmail, payload, isTestOrder, emailSettings, now });
}

/**
 * reservationExpiresAtMs MUST be reservation.expiresAt.toMillis() — the
 * value already persisted on the reservation document — never a
 * transaction-local `now`. A Firestore transaction can internally retry
 * its whole body on contention, and `now` would differ across those
 * retries while the reservation's own stored expiresAt would not, until
 * the NEXT re-reservation assigns a fresh one. That is also exactly what
 * makes this id naturally distinct across a genuine re-reserve -> expire
 * -> re-reserve -> expire cycle on the same order.
 */
function enqueueReservationExpired(tx, db, { orderId, reservationExpiresAtMs, recipientEmail, payload, isTestOrder, emailSettings, now }) {
  return enqueueEmail(tx, db, {
    type: 'reservation-expired',
    idParts: [orderId, String(reservationExpiresAtMs)],
    orderId,
    intendedRecipientEmail: recipientEmail,
    payload,
    isTestOrder,
    emailSettings,
    now,
  });
}

/**
 * Fulfillment transitions each fire at most once per order — verified
 * directly against admin-update-fulfillment.js's VALID_FROM table, which
 * has no back-edges (unfulfilled->processing->{ready|shipped}->completed,
 * never the reverse) — so no extra discriminator is needed for these four.
 */
function enqueueFulfillmentEvent(tx, db, { status, orderId, recipientEmail, payload, isTestOrder, emailSettings, now }) {
  const type = { processing: 'fulfillment-processing', ready_for_pickup: 'fulfillment-ready', shipped: 'fulfillment-shipped', completed: 'fulfillment-completed' }[status];
  if (!type) throw new Error(`enqueueFulfillmentEvent: no email type for fulfillment status "${status}".`);
  return enqueueEmail(tx, db, { type, idParts: [orderId], orderId, intendedRecipientEmail: recipientEmail, payload, isTestOrder, emailSettings, now });
}

function enqueueAdminNewOrder(tx, db, { orderId, adminEmail, payload, isTestOrder, emailSettings, now }) {
  return enqueueEmail(tx, db, { type: 'order-admin-new', idParts: [orderId], orderId, intendedRecipientEmail: adminEmail, payload, isTestOrder, emailSettings, now });
}

function enqueueAdminPaymentReview(tx, db, { orderId, attemptId, adminEmail, payload, isTestOrder, emailSettings, now }) {
  return enqueueEmail(tx, db, { type: 'payment-admin-review', idParts: [orderId, attemptId], orderId, intendedRecipientEmail: adminEmail, payload, isTestOrder, emailSettings, now });
}

function enqueueEventInquiryAdmin(tx, db, { inquiryId, adminEmail, payload, emailSettings, now }) {
  return enqueueEmail(tx, db, { type: 'event-inquiry-admin', idParts: [inquiryId], inquiryId, intendedRecipientEmail: adminEmail, payload, isTestOrder: false, emailSettings, now });
}

function enqueueEventInquiryCustomer(tx, db, { inquiryId, recipientEmail, payload, emailSettings, now }) {
  return enqueueEmail(tx, db, { type: 'event-inquiry-customer', idParts: [inquiryId], inquiryId, intendedRecipientEmail: recipientEmail, payload, isTestOrder: false, emailSettings, now });
}

module.exports = {
  EMAIL_TYPES,
  ACTION_SCOPES,
  READ_ONLY_TTL_MS,
  ACTION_TTL_MS,
  ttlForScopes,
  buildOutboxId,
  resolveDelivery,
  enqueueEmail,
  enqueueOrderCreated,
  enqueuePaymentSubmitted,
  enqueuePaymentRejected,
  enqueuePaymentApproved,
  enqueueReservationExpired,
  enqueueFulfillmentEvent,
  enqueueAdminNewOrder,
  enqueueAdminPaymentReview,
  enqueueEventInquiryAdmin,
  enqueueEventInquiryCustomer,
};
