/*
 * Constants governing the scheduled email processor's behavior. Centralized
 * here (rather than scattered across process-email-outbox.js) so the
 * offline test suite can assert on the exact same values production runs
 * with — no risk of a test silently checking a different number than what
 * actually ships.
 */

// ---- Resend idempotency window ----
// Resend documents a 24-hour retention window for idempotency keys. This
// app's internal "is it still safe to retry with the same key?" threshold
// is kept deliberately conservative — well inside that window, not equal
// to it — so there is real margin, not a hairline. Kept as a HARD CODE
// CONSTANT rather than a freely configurable environment variable: an
// accidental production env value (e.g. someone typing "48 hours") could
// otherwise silently weaken duplicate-send protection with no code review
// catching it. If a shorter value is ever needed for testing, override
// via EMAIL_IDEMPOTENCY_WINDOW_MS_TEST_OVERRIDE — the exported getter below
// still HARD-CAPS whatever that env var provides at this constant; it can
// only ever make the window MORE conservative, never less.
const RESEND_IDEMPOTENCY_SAFE_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours

function getIdempotencySafeWindowMs() {
  const override = Number(process.env.EMAIL_IDEMPOTENCY_WINDOW_MS_TEST_OVERRIDE);
  if (Number.isFinite(override) && override > 0 && override < RESEND_IDEMPOTENCY_SAFE_WINDOW_MS) {
    return override;
  }
  return RESEND_IDEMPOTENCY_SAFE_WINDOW_MS;
}

// ---- Claim lease ----
// How long a document stays "sending" before it's considered stale and
// eligible for stale-lease recovery. Generous relative to a single Resend
// call + a couple of small Firestore writes, short enough that a genuine
// crash is retried within a few processor runs.
const LEASE_DURATION_MS = 3 * 60 * 1000; // 3 minutes

// ---- Retry backoff ----
// Index 0 = delay before attempt 2, ..., index 3 = delay before attempt 5.
// After attempt 5 fails, the event becomes failed_permanent.
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];

function backoffMsForAttempt(attemptNumber) {
  // attemptNumber is 1-based (the attempt that just failed).
  const index = Math.min(attemptNumber - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[Math.max(index, 0)];
}

// ---- Bounded batch/concurrency ----
// Netlify Scheduled Functions have a 30-second execution ceiling — this is
// the real constraint driving every number below, not a plan-tier limit
// (none was found exposed anywhere in this site's Netlify API data).
const QUERY_A_LIMIT = 12; // pending/failed, due now
const QUERY_B_LIMIT = 8; // sending, with an expired lease (should be rare in steady state)
const SEND_CONCURRENCY = 4;
const RUN_TIME_BUDGET_MS = 22 * 1000; // stop picking up new work after this; leaves margin before the 30s hard kill

// ---- Cadence ----
// The only cadence with actual production evidence on this Netlify site is
// the 5-minute cron already running (inventory-cleanup-expired-reservations.js).
// No plan-tier restriction on cadence was found via the Netlify API, but
// none of that is positive evidence a faster interval fires reliably either
// — so this stays at the proven value for V1.
const CRON_SCHEDULE = '*/5 * * * *';

module.exports = {
  RESEND_IDEMPOTENCY_SAFE_WINDOW_MS,
  getIdempotencySafeWindowMs,
  LEASE_DURATION_MS,
  MAX_ATTEMPTS,
  BACKOFF_MS,
  backoffMsForAttempt,
  QUERY_A_LIMIT,
  QUERY_B_LIMIT,
  SEND_CONCURRENCY,
  RUN_TIME_BUDGET_MS,
  CRON_SCHEDULE,
};
