/*
 * Scheduled email processor (Phase 5E) — runs every 5 minutes via
 * @netlify/functions' schedule(). This is the ONLY place in the entire
 * app that calls Resend. Every commerce/inquiry endpoint only ever
 * enqueues a durable emailOutbox document (see _shared/emailOutbox.js);
 * this function is fully decoupled from all of them, so a Resend outage
 * can never affect an order/payment/fulfillment/inquiry request.
 *
 * ---- Three-layer duplicate-send protection ----
 *   1. Deterministic outbox document ID (emailOutbox.js) — a retried
 *      commerce request re-enqueues the SAME document, never a new one.
 *   2. Claim-before-send transaction (claim(), below) — a document is
 *      only ever sent by whichever invocation successfully claims it, so
 *      two concurrent processor runs can never both send the same email.
 *   3. Resend's own Idempotency-Key header, set to the outbox document's
 *      own ID — Resend deduplicates identical requests sharing a key
 *      within its own retention window (see emailProcessorConfig.js).
 *
 * ---- Crash recovery ----
 * If this function crashes/times out mid-send, the claimed document is
 * left in `sending` with a leaseExpiresAt a few minutes out. A later run's
 * stale-lease query picks it back up automatically. Whether it's then
 * safe to retry with the SAME Resend idempotency key depends on
 * firstSendAttemptAt: within RESEND_IDEMPOTENCY_SAFE_WINDOW_MS (12h,
 * hardcoded), Resend itself prevents a duplicate even if the earlier call
 * actually succeeded before the crash. Past that window, retrying blind
 * would risk a real duplicate customer email, so the event instead
 * becomes `delivery_unknown` — a terminal state, never auto-resent. That
 * check happens INSIDE the claim transaction, atomically with the claim
 * itself, so it can never race with another invocation.
 *
 * ---- What this function sends ----
 * ONLY the values already snapshotted on the outbox document at enqueue
 * time (effectiveRecipientEmail, fromAddress, siteBaseUrl, payload,
 * tokenClaims, ...). It never re-reads EMAIL_FROM / SITE_URL / the QA
 * override / the current email mode — a later change to any of those can
 * only affect events enqueued AFTER that change, never one already
 * sitting in the outbox. The one necessary exception is secrets
 * (RESEND_API_KEY, EMAIL_TOKEN_SECRET), which were never snapshotted
 * anywhere and are read fresh from the environment on every send, same as
 * any other server credential.
 *
 * Suppressed events (suppressed_test / suppressed_disabled) are written
 * as permanently terminal at enqueue time and never match either query
 * below — there is no code path here, or anywhere, that resurrects one.
 */
const { schedule } = require('@netlify/functions');
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { generateEmailToken } = require('./_shared/emailAccessToken');
const { renderEmail } = require('./_shared/emailTemplates');
const { sendEmail, ResendSendError } = require('./_shared/resendClient');
const {
  getIdempotencySafeWindowMs,
  LEASE_DURATION_MS,
  MAX_ATTEMPTS,
  backoffMsForAttempt,
  QUERY_A_LIMIT,
  QUERY_B_LIMIT,
  SEND_CONCURRENCY,
  RUN_TIME_BUDGET_MS,
  CRON_SCHEDULE,
} = require('./_shared/emailProcessorConfig');

const SENDABLE_STATUSES = ['pending', 'failed'];

/** order.html reads its token ONLY from the URL fragment — never a query string — so it never reaches a server log or referer header. Same rule as the primary access token (see js/order.js). */
function buildOrderLink(siteBaseUrl, token) {
  if (!token) return null;
  const base = String(siteBaseUrl || '').replace(/\/+$/, '');
  return `${base}/order.html#token=${encodeURIComponent(token)}`;
}

function sanitizeUnknownError(err) {
  // Never let an arbitrary caught error (which could embed request
  // internals) reach Firestore verbatim — same narrow philosophy as
  // resendClient.js's sanitizeSendError, for failures raised OUTSIDE
  // Resend itself (token generation, template rendering).
  const msg = err && err.message ? String(err.message) : String(err);
  return 'Processing error: ' + msg.slice(0, 200);
}

async function fetchCandidates(db, now) {
  const [dueSnap, staleSnap] = await Promise.all([
    db
      .collection('emailOutbox')
      .where('status', 'in', SENDABLE_STATUSES)
      .where('nextAttemptAt', '<=', now)
      .orderBy('nextAttemptAt', 'asc')
      .limit(QUERY_A_LIMIT)
      .get(),
    db
      .collection('emailOutbox')
      .where('status', '==', 'sending')
      .where('leaseExpiresAt', '<=', now)
      .orderBy('leaseExpiresAt', 'asc')
      .limit(QUERY_B_LIMIT)
      .get(),
  ]);
  // Mutually exclusive status sets (pending/failed vs sending) — no
  // possibility of the same document appearing in both result sets.
  return [...dueSnap.docs, ...staleSnap.docs];
}

/**
 * Re-reads `ref` inside its own transaction and re-verifies eligibility
 * before writing — the same "reload and re-check, never trust the outer
 * query" pattern _shared/inventory.js's expireReservationIfDue uses — so a
 * document already claimed or already resolved by a concurrent invocation
 * is simply skipped, never double-sent.
 *
 * @returns { terminal:true } if the document was moved straight to
 *          delivery_unknown (idempotency window exceeded — do not send);
 *          the claimed document's data if it was claimed for sending; or
 *          null if it was not (or no longer) eligible.
 */
async function claim(db, ref, now) {
  const safeWindowMs = getIdempotencySafeWindowMs();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data();

    const dueNow = SENDABLE_STATUSES.includes(data.status) && data.nextAttemptAt && data.nextAttemptAt.toMillis() <= now.toMillis();
    const staleLease = data.status === 'sending' && data.leaseExpiresAt && data.leaseExpiresAt.toMillis() <= now.toMillis();
    if (!dueNow && !staleLease) return null;

    if (data.firstSendAttemptAt && now.toMillis() - data.firstSendAttemptAt.toMillis() > safeWindowMs) {
      tx.update(ref, {
        status: 'delivery_unknown',
        leaseExpiresAt: null,
        lastError: 'Uncertain whether this email was sent before a prior attempt was interrupted, and the Resend idempotency window has passed — will not auto-retry.',
      });
      return { terminal: true };
    }

    const firstSendAttemptAt = data.firstSendAttemptAt || now;
    tx.update(ref, {
      status: 'sending',
      processingStartedAt: now,
      leaseExpiresAt: admin.firestore.Timestamp.fromMillis(now.toMillis() + LEASE_DURATION_MS),
      firstSendAttemptAt,
    });

    return { ...data, firstSendAttemptAt };
  });
}

async function handleSendFailure(ref, data, err, stats) {
  const attempts = (data.attempts || 0) + 1;
  const message = err instanceof ResendSendError ? err.message : sanitizeUnknownError(err);

  if (attempts >= MAX_ATTEMPTS) {
    await ref.update({ status: 'failed_permanent', attempts, lastError: message });
    stats.failedPermanent += 1;
    console.error(`process-email-outbox: ${ref.id} permanently failed after ${attempts} attempt(s): ${message}`);
    return;
  }

  const delayMs = backoffMsForAttempt(attempts);
  const nextAttemptAt = admin.firestore.Timestamp.fromMillis(Date.now() + delayMs);
  await ref.update({ status: 'failed', attempts, nextAttemptAt, lastError: message });
  stats.failed += 1;
}

async function processOne(db, docSnap, stats) {
  let claimResult;
  try {
    claimResult = await claim(db, docSnap.ref, admin.firestore.Timestamp.now());
  } catch (err) {
    console.error(`process-email-outbox: claim failed for ${docSnap.id}:`, err);
    stats.errors += 1;
    return;
  }

  if (!claimResult) {
    stats.skipped += 1;
    return;
  }
  if (claimResult.terminal) {
    stats.deliveryUnknown += 1;
    return;
  }

  stats.claimed += 1;
  const data = claimResult;

  try {
    let token = null;
    if (data.tokenClaims && data.orderId) {
      token = generateEmailToken({ outboxDocId: docSnap.id, orderId: data.orderId, tokenClaims: data.tokenClaims });
    }
    const orderLink = buildOrderLink(data.siteBaseUrl, token);
    const { subject, html } = renderEmail(data.templateType, data.payload, orderLink);

    const result = await sendEmail({
      idempotencyKey: docSnap.id,
      to: data.effectiveRecipientEmail,
      from: data.fromAddress,
      subject,
      html,
    });

    await docSnap.ref.update({
      status: 'sent',
      sentAt: admin.firestore.Timestamp.now(),
      resendMessageId: result.messageId,
      lastError: null,
    });
    stats.sent += 1;
  } catch (err) {
    await handleSendFailure(docSnap.ref, data, err, stats);
  }
}

async function processAll(db, docs, startTime) {
  const stats = { claimed: 0, sent: 0, failed: 0, failedPermanent: 0, deliveryUnknown: 0, skipped: 0, errors: 0 };
  let cursor = 0;

  async function worker() {
    for (;;) {
      if (Date.now() - startTime > RUN_TIME_BUDGET_MS) return;
      const i = cursor;
      cursor += 1;
      if (i >= docs.length) return;
      // eslint-disable-next-line no-await-in-loop
      await processOne(db, docs[i], stats);
    }
  }

  const workerCount = Math.min(SEND_CONCURRENCY, docs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return stats;
}

async function run() {
  const db = getDb();
  const startTime = Date.now();
  const now = admin.firestore.Timestamp.now();

  const candidates = await fetchCandidates(db, now);
  console.log(`process-email-outbox: ${candidates.length} candidate(s) found (due + stale-lease).`);

  const stats = await processAll(db, candidates, startTime);
  console.log(`process-email-outbox: ${JSON.stringify(stats)}`);
  return stats;
}

exports.handler = schedule(CRON_SCHEDULE, async () => {
  await run();
  return { statusCode: 200 };
});

// Exported ADDITIONALLY (exports.handler above is untouched) purely for
// scripts/test-email-system.js's offline unit coverage of the claim /
// backoff / idempotency-window logic against a mock Firestore — no live
// Firestore or Netlify Scheduled Function invocation needed to test it.
module.exports.claim = claim;
module.exports.handleSendFailure = handleSendFailure;
module.exports.buildOrderLink = buildOrderLink;
module.exports.sanitizeUnknownError = sanitizeUnknownError;
