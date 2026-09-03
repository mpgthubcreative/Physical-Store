/*
 * OFFLINE SECURITY TEST — proves the read-only auth-cache boundary from the
 * actual source of every admin- and owner- function, not just from a comment.
 * No credentials, no network.
 *
 * The rule: requireAdminCached()/requireOwnerCached() (the short-lived
 * in-memory admin-status cache) may be used ONLY by endpoints that read
 * data and change nothing. Every mutation and every sensitive action must
 * keep using requireAdmin()/requireOwner() (always a fresh Firestore read),
 * so a disabled account is refused those actions immediately, every time.
 *
 * This test checks BOTH directions:
 *   - every approved read endpoint actually uses the cached path (so the
 *     performance fix is real, not just claimed)
 *   - every mutation/sensitive endpoint does NOT use the cached path (the
 *     actual security boundary)
 *   - nothing outside either list exists (a new admin-* file added later
 *     must be explicitly classified, not silently fall through)
 *
 * Usage: node scripts/test-auth-cache-boundary.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const FN_DIR = path.join(__dirname, '..', 'netlify', 'functions');

// The 11 endpoints explicitly approved for the cache: Dashboard/report
// reads, Orders list, Order Detail read, Products/Patches/Collections
// lists, Settings read, Team list.
const APPROVED_CACHED = new Set([
  'admin-dashboard.js',
  'admin-report.js',
  'admin-order-stats.js',
  'admin-catalog-stats.js',
  'admin-list-orders.js',
  'admin-get-order.js',
  'admin-list-products.js',
  'admin-list-patches.js',
  'admin-list-collections.js',
  'admin-get-settings.js',
  'admin-list-team.js',
]);

// Every mutation or otherwise sensitive endpoint. Deliberately explicit and
// exhaustive rather than "everything not in APPROVED_CACHED" — a new file
// that matches neither list fails loudly below instead of silently landing
// on one side or the other.
const MUST_STAY_FRESH = new Set([
  'admin-approve-payment.js',
  'admin-reject-payment.js',
  'admin-update-fulfillment.js',
  'admin-save-product.js',
  'admin-archive-product.js',
  'admin-reactivate-product.js',
  'admin-delete-product.js',
  'admin-get-product.js', // judgment call: not explicitly approved for the cache — left fresh
  'admin-save-patch.js',
  'admin-archive-patch.js',
  'admin-reactivate-patch.js',
  'admin-delete-patch.js',
  'admin-save-collection.js',
  'admin-archive-collection.js',
  'admin-reactivate-collection.js',
  'admin-delete-collection.js',
  'admin-save-payment-settings.js',
  'admin-save-shipping-settings.js',
  'admin-request-image-upload.js',
  'admin-finalize-image-upload.js',
  'admin-remove-image.js',
  'admin-report-export.js', // judgment call: infrequent, exports order data — left fresh
  'admin-benchmark-firestore-transport.js', // temporary diagnostic tool — deliberately the strictest check, not the cache
  'owner-create-admin.js',
  'owner-disable-admin.js',
  'owner-reactivate-admin.js',
  'owner-remove-admin.js',
]);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    console.error('  FAIL  ' + name + '\n        ' + err.message);
    process.exitCode = 1;
  }
}

function usesCachedAuth(src) {
  return /requireAdminCached\s*\(|requireOwnerCached\s*\(/.test(src);
}
function usesFreshAuth(src) {
  // Matches the actual call sites (event/...), not just the word appearing
  // in a comment or another identifier like requireAdminCached.
  return /\brequireAdmin\s*\(\s*event|\brequireOwner\s*\(\s*event/.test(src);
}

console.log('\n=== Auth-cache security boundary (static source inspection) ===\n');

for (const file of APPROVED_CACHED) {
  test(`APPROVED READ endpoint uses the cached path: ${file}`, () => {
    const src = fs.readFileSync(path.join(FN_DIR, file), 'utf8');
    assert.ok(usesCachedAuth(src), `${file} must call requireAdminCached()/requireOwnerCached()`);
    assert.ok(!usesFreshAuth(src), `${file} must not ALSO call the fresh requireAdmin()/requireOwner() directly`);
  });
}

for (const file of MUST_STAY_FRESH) {
  test(`MUTATION/SENSITIVE endpoint stays on the fresh path: ${file}`, () => {
    const fp = path.join(FN_DIR, file);
    assert.ok(fs.existsSync(fp), `expected file not found: ${file} (renamed? update this test)`);
    const src = fs.readFileSync(fp, 'utf8');
    assert.ok(!usesCachedAuth(src), `${file} MUST NEVER use the cached admin-status path`);
  });
}

test('every admin- and owner- file that authorizes at all is classified into exactly one list', () => {
  const all = fs.readdirSync(FN_DIR).filter((f) => f.endsWith('.js') && (f.startsWith('admin-') || f.startsWith('owner-')));
  const unclassified = [];
  const both = [];
  for (const file of all) {
    const src = fs.readFileSync(path.join(FN_DIR, file), 'utf8');
    const authorizes = usesCachedAuth(src) || usesFreshAuth(src);
    if (!authorizes) continue; // a file with no auth call at all (shouldn't exist, but not this test's job)
    const inCached = APPROVED_CACHED.has(file);
    const inFresh = MUST_STAY_FRESH.has(file);
    if (inCached && inFresh) both.push(file);
    if (!inCached && !inFresh) unclassified.push(file);
  }
  assert.deepStrictEqual(both, [], 'a file cannot be in both lists');
  assert.deepStrictEqual(unclassified, [], 'unclassified admin-authorizing file(s) — a new endpoint was added without deciding cached vs fresh');
});

console.log('\n=== requireAdminCached() itself (source inspection of _shared/adminAuth.js) ===\n');

const adminAuthSrc = fs.readFileSync(path.join(FN_DIR, '_shared', 'adminAuth.js'), 'utf8');

test('verifyIdToken always runs inside requireAdminCached — never skipped, cache or no cache', () => {
  const fn = adminAuthSrc.slice(adminAuthSrc.indexOf('async function requireAdminCached'), adminAuthSrc.indexOf('async function requireOwnerCached'));
  assert.ok(/verifyIdToken/.test(fn), 'requireAdminCached must call verifyIdToken()');
  // The cache lookup must happen AFTER verification, not instead of it —
  // i.e. verifyIdToken is not inside an `if (!cached)` branch.
  const verifyIdx = fn.indexOf('verifyIdToken');
  const cacheGetIdx = fn.indexOf('adminStatusCache.get');
  assert.ok(verifyIdx > -1 && cacheGetIdx > -1 && verifyIdx < cacheGetIdx, 'token verification must run before any cache lookup');
});

test('the cache stores only a boolean disabled flag — never a token', () => {
  const fn = adminAuthSrc.slice(adminAuthSrc.indexOf('async function requireAdminCached'), adminAuthSrc.indexOf('async function requireOwnerCached'));
  assert.ok(/adminStatusCache\.set\(decoded\.uid,\s*disabled,/.test(fn), 'cache.set must store (uid, disabled boolean, ttl) — nothing else');
  assert.ok(!/adminStatusCache\.set\([^)]*token/i.test(fn), 'the cache must never be given the raw token');
});

test('TTL is within the approved 15-30 second range', () => {
  const match = /ADMIN_STATUS_CACHE_TTL_MS\s*=\s*([\d.]+)\s*\*\s*([\d.]+)/.exec(adminAuthSrc) || /ADMIN_STATUS_CACHE_TTL_MS\s*=\s*(\d+)/.exec(adminAuthSrc);
  assert.ok(match, 'could not find ADMIN_STATUS_CACHE_TTL_MS definition');
  const ttlMs = match[2] ? Number(match[1]) * Number(match[2]) : Number(match[1]);
  assert.ok(ttlMs >= 15000 && ttlMs <= 30000, `TTL ${ttlMs}ms is outside the approved 15-30s range`);
});

test('a Firestore error on the status read fails OPEN and is not cached (transient failures must not freeze a stale answer)', () => {
  const fn = adminAuthSrc.slice(adminAuthSrc.indexOf('async function requireAdminCached'), adminAuthSrc.indexOf('async function requireOwnerCached'));
  // requireAdminCached has TWO `catch (err) {` blocks: one for verifyIdToken,
  // one for the Firestore status read. lastIndexOf isolates the second —
  // the one that actually guards the cache write — rather than the first
  // (whose naive slice-to-end would wrongly include the legitimate
  // success-path .set() call and false-fail this assertion).
  const catchBlock = fn.slice(fn.lastIndexOf('} catch (err) {'));
  assert.ok(!/adminStatusCache\.set/.test(catchBlock), 'a failed read must not be written to the cache');
});

test('requireAdmin() and requireOwner() (the fresh path) never reference the cache at all', () => {
  const freshSection = adminAuthSrc.slice(
    adminAuthSrc.indexOf('async function verifyAdminToken'),
    adminAuthSrc.indexOf('SHORT-LIVED ADMIN-STATUS CACHE')
  );
  assert.ok(!/adminStatusCache/.test(freshSection), 'the fresh verifyAdminToken/requireAdmin/requireOwner path must be completely untouched by the cache');
});

console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES ABOVE' : ' — all green') + '\n');
