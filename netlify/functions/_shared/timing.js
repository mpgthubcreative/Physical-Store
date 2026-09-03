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
 * useful number here: on a freshly spawned Lambda it includes the whole
 * runtime bootstrap plus every `require()` the function performed, so a
 * large value on the first invocation of an instance is direct evidence
 * that module loading — not the query — dominates. firebase-admin pulls in
 * @google-cloud/firestore, which alone costs ~1s to require on a fast
 * machine and more on a Lambda.
 */

// Set when THIS module is first loaded, i.e. very early in the function's
// module graph. Comparing it to handler-start time approximates how long
// the remaining requires took.
const MODULE_LOADED_AT = Date.now();

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
   *   cold             — first invocation on this Lambda instance
   *   uptimeAtStartMs  — process age when the handler began; on a cold hit
   *                      this is essentially the module-load + bootstrap cost
   *   moduleLoadMs     — time between this module loading and handler start
   *   <stage>          — each measured stage
   *   totalHandlerMs   — whole handler duration
   */
  function summary() {
    return {
      cold: wasCold,
      uptimeAtStartMs,
      moduleLoadMs: startedAt - MODULE_LOADED_AT,
      ...stages,
      totalHandlerMs: Date.now() - startedAt,
    };
  }

  return { time, record, summary };
}

module.exports = { createTimer };
