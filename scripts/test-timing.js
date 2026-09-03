/*
 * OFFLINE TEST — the timing diagnostic itself.
 *
 * Exists because of a real bug: `moduleLoadMs` reported 495507 in
 * production (a warm container that had been alive ~8 minutes), not a
 * 495-second module load. It was computing wall-clock time since the
 * container booted, not module-load duration. Replaced with
 * `firebaseAdminRequireMs`, measured directly around the actual
 * require('firebase-admin') call — this pins that it behaves correctly:
 * a real, small, non-negative duration, IDENTICAL across every timer
 * created in this process (because Node's module cache means the require
 * only actually runs once).
 *
 * Usage: node scripts/test-timing.js
 */
const assert = require('assert');

process.env.FIREBASE_STORAGE_BUCKET = 'buddy-shop-45fc4.firebasestorage.app';

const { createTimer } = require('../netlify/functions/_shared/timing');
const { FIREBASE_ADMIN_REQUIRE_MS } = require('../netlify/functions/_shared/firebaseAdmin');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log('  PASS  ' + name);
    })
    .catch((err) => {
      console.error('  FAIL  ' + name + '\n        ' + err.message);
      process.exitCode = 1;
    });
}

async function main() {
  console.log('\n=== firebaseAdminRequireMs (replaces the broken moduleLoadMs) ===');

  await test('is a small, finite, non-negative number — not 495507', () => {
    assert.ok(Number.isFinite(FIREBASE_ADMIN_REQUIRE_MS), 'must be a real number');
    assert.ok(FIREBASE_ADMIN_REQUIRE_MS >= 0, 'must not be negative');
    assert.ok(FIREBASE_ADMIN_REQUIRE_MS < 10000, `implausibly large: ${FIREBASE_ADMIN_REQUIRE_MS}ms — require() should not take 10s+`);
  });

  await test('is IDENTICAL across multiple timers — the require only ran once (module cache)', () => {
    const a = createTimer().summary().firebaseAdminRequireMs;
    const b = createTimer().summary().firebaseAdminRequireMs;
    const c = createTimer().summary().firebaseAdminRequireMs;
    assert.strictEqual(a, FIREBASE_ADMIN_REQUIRE_MS);
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
  });

  await test('does NOT grow with elapsed wall-clock time (the actual bug)', async () => {
    const before = createTimer().summary().firebaseAdminRequireMs;
    await new Promise((r) => setTimeout(r, 120));
    const after = createTimer().summary().firebaseAdminRequireMs;
    // The old moduleLoadMs would have grown by ~120ms here. This must not.
    assert.strictEqual(before, after, 'firebaseAdminRequireMs must not increase with time — it is a one-time duration, not an age');
  });

  console.log('\n=== summary() shape ===');

  await test('moduleLoadMs is gone entirely', () => {
    const s = createTimer().summary();
    assert.strictEqual(s.moduleLoadMs, undefined, 'the broken field must not reappear');
  });

  await test('cold flag flips to false after the first timer in this process', () => {
    // NOTE: by the time this test runs, earlier tests in this file have
    // already created timers, so cold is expected to already be false here
    // — that IS the behavior being verified (first-in-process is cold,
    // everything after is warm).
    const s = createTimer().summary();
    assert.strictEqual(s.cold, false);
  });

  await test('totalHandlerMs reflects real elapsed time', async () => {
    const timer = createTimer();
    await new Promise((r) => setTimeout(r, 50));
    const s = timer.summary();
    assert.ok(s.totalHandlerMs >= 45, `expected at least ~50ms, got ${s.totalHandlerMs}`);
  });

  await test('record() and time() both land in the summary, stage names only — no PII shape smuggled in', async () => {
    const timer = createTimer();
    timer.record('authStatusReadMs', 12);
    await timer.time('firestoreQueryMs', () => new Promise((r) => setTimeout(r, 10)));
    const s = timer.summary();
    assert.strictEqual(s.authStatusReadMs, 12);
    assert.ok(s.firestoreQueryMs >= 8);
    for (const key of Object.keys(s)) {
      assert.ok(!/token|email|uid|customer/i.test(key), `suspicious key in timing summary: ${key}`);
    }
  });

  console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES ABOVE' : ' — all green') + '\n');
}

main();
