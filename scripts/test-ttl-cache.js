/*
 * OFFLINE TEST — the pure TTL cache mechanism backing requireAdminCached().
 * No credentials, no network, no Firebase.
 *
 * Usage: node scripts/test-ttl-cache.js
 */
const assert = require('assert');
const { TTLCache } = require('../netlify/functions/_shared/ttlCache');

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
  console.log('\n=== TTLCache ===');

  await test('a missing key returns undefined', () => {
    const c = new TTLCache();
    assert.strictEqual(c.get('nope'), undefined);
  });

  await test('set/get round-trips within the TTL', () => {
    const c = new TTLCache();
    c.set('uid1', true, 5000);
    assert.strictEqual(c.get('uid1'), true);
  });

  await test('CRITICAL: a cached `false` is retrievable, never confused with "not cached"', () => {
    // The whole point of the cache is storing "is this account disabled?" —
    // the overwhelmingly common value is `false` (not disabled). If get()
    // could not distinguish a cached `false` from a cache miss, every
    // active admin would silently bypass the cache on every single request.
    const c = new TTLCache();
    c.set('uid1', false, 5000);
    assert.strictEqual(c.get('uid1'), false);
    assert.notStrictEqual(c.get('uid1'), undefined);
  });

  await test('a cached `true` (disabled) is also retrievable', () => {
    const c = new TTLCache();
    c.set('uid1', true, 5000);
    assert.strictEqual(c.get('uid1'), true);
  });

  await test('distinct keys never collide', () => {
    const c = new TTLCache();
    c.set('uidA', false, 5000);
    c.set('uidB', true, 5000);
    assert.strictEqual(c.get('uidA'), false);
    assert.strictEqual(c.get('uidB'), true);
  });

  await test('a real entry actually expires after its TTL elapses', async () => {
    const c = new TTLCache();
    c.set('uid1', false, 40);
    assert.strictEqual(c.get('uid1'), false, 'should still be cached immediately after set');
    await new Promise((r) => setTimeout(r, 70));
    assert.strictEqual(c.get('uid1'), undefined, 'must have expired');
  });

  await test('an expired entry is evicted from the store on read (no unbounded growth)', async () => {
    const c = new TTLCache();
    c.set('uid1', false, 30);
    await new Promise((r) => setTimeout(r, 60));
    c.get('uid1'); // triggers eviction
    assert.strictEqual(c.size, 0);
  });

  await test('re-set overwrites both the value and the expiry', async () => {
    const c = new TTLCache();
    c.set('uid1', true, 30);
    await new Promise((r) => setTimeout(r, 15));
    c.set('uid1', false, 5000); // fresh TTL
    await new Promise((r) => setTimeout(r, 30)); // past the ORIGINAL ttl, well within the new one
    assert.strictEqual(c.get('uid1'), false, 'must reflect the newer value+TTL, not the stale one');
  });

  await test('delete() removes a specific key without affecting others', () => {
    const c = new TTLCache();
    c.set('uidA', false, 5000);
    c.set('uidB', false, 5000);
    c.delete('uidA');
    assert.strictEqual(c.get('uidA'), undefined);
    assert.strictEqual(c.get('uidB'), false);
  });

  await test('clear() empties the whole cache', () => {
    const c = new TTLCache();
    c.set('uidA', false, 5000);
    c.set('uidB', true, 5000);
    c.clear();
    assert.strictEqual(c.size, 0);
    assert.strictEqual(c.get('uidA'), undefined);
  });

  console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES ABOVE' : ' — all green') + '\n');
}

main();
