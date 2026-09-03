/*
 * Lightweight server-side timing for Netlify Functions.
 *
 * Purpose: tell apart "the Firestore query is slow" from "the shared
 * per-invocation cost is slow". Three Dashboard endpoints with tiny
 * payloads all returning in ~3.7s points at the latter, and guessing which
 * stage is responsible is not good enough — this measures it.
 *
 * ---- Privacy ----
 * Records ONLY stage names and millisecond durations. It never touches, and
 * must never be given, a token, credential, email address, uid, or any
 * customer data. The output is safe to return in a response body.
 *
 * ---- Cold-start detection ----
 * `process.uptime()` at the moment the handler starts is the single most
 * useful general-purpose number here: on a freshly spawned Lambda it
 * includes the whole runtime bootstrap plus every `require()` the function
 * performed, so a large value on the first invocation of an instance is
 * evidence that module loading and platform bootstrap — not the query —
 * dominate. But it is only a correlate: on a container that has been alive
 * and idle for a while before this request, `uptimeAtStartMs` can also be
 * large for reasons that have nothing to do with module loading.
 *
 * For the specific "did requiring firebase-admin cost us time" question,
 * `firebaseAdminRequireMs` (below) is the direct measurement, taken by
 * timing the actual require() call in _shared/firebaseAdmin.js. An earlier
 * version of this file tried to approximate that by comparing this
 * module's own load time to the moment the handler started, exposed as
 * `moduleLoadMs` — but on any request after the first in a given
 * container, that comparison measures wall-clock time since the container
 * booted (which can be minutes), not module-load duration, and it showed
 * exactly that in production (moduleLoadMs: 495507 on a warm container that
 * had been alive for ~8 minutes). That field has been removed in favor of
 * the real measurement below.
 */
const { FIREBASE_ADMIN_REQUIRE_MS } = require('./firebaseAdmin');

// Flipped to false after the first handler invocation on this instance, so
// a warm hit is clearly distinguishable from a cold one.
let instanceIsCold = true;

function createTimer() {
  const startedAt = Date.now();
  const wasCold = instanceIsCold;
  const uptimeAtStartMs = Math.round(process.uptime() * 1000);
  instanceIsCold = false;

  const stages = {};

  /** Times an async stage and returns whatever it resolves to. */
  async function time(name, fn) {
    const s = Date.now();
    try {
      return await fn();
    } finally {
      stages[name] = Date.now() - s;
    }
  }

  /** Records a stage duration measured elsewhere. */
  function record(name, ms) {
    stages[name] = ms;
  }

  /**
   * The timing summary, safe to embed in a JSON response.
   *
   *   cold                 — first invocation on this Lambda instance
   *   uptimeAtStartMs      — process age when the handler began; large on a
   *                          genuinely fresh container, but also grows on a
   *                          long-lived idle one, so treat it as a hint,
   *                          not proof, of a cold start
   *   firebaseAdminRequireMs — the ACTUAL duration of require('firebase-admin'),
   *                          measured once per container. Non-trivial (can
   *                          be ~1s+) only on the first invocation after a
   *                          container boots; near-zero on every later
   *                          invocation in that same container, because
   *                          Node's module cache returns the already-
   *                          computed value instead of re-running the
   *                          require.
   *   <stage>               — each measured stage (authVerifyTokenMs,
   *                          authStatusReadMs, firestoreQueryMs, ...)
   *   totalHandlerMs        — whole handler duration
   */
  function summary() {
    return {
      cold: wasCold,
      uptimeAtStartMs,
      firebaseAdminRequireMs: FIREBASE_ADMIN_REQUIRE_MS,
      ...stages,
      totalHandlerMs: Date.now() - startedAt,
    };
  }

  return { time, record, summary };
}

module.exports = { createTimer };
