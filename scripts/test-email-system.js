/*
 * OFFLINE UNIT TEST — no Firebase credentials, no network, no Firestore.
 * Phase 5E (Resend + Transactional Emails). Exercises the pure logic that
 * makes the outbox/token/processor guarantees actually hold: deterministic
 * IDs, scoped token verification, suppression precedence, the hard-capped
 * Resend idempotency window, retry backoff, and the claim/lease/recovery
 * transaction — all against mock Firestore, never a real project.
 *
 * Usage: node scripts/test-email-system.js
 */
const assert = require('assert');

process.env.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'buddy-shop-45fc4.firebasestorage.app';
process.env.EMAIL_TOKEN_SECRET = process.env.EMAIL_TOKEN_SECRET || 'test-email-token-secret-do-not-use-in-prod';
process.env.RATE_LIMIT_SECRET = process.env.RATE_LIMIT_SECRET || 'test-rate-limit-secret-do-not-use-in-prod';
delete process.env.EMAIL_QA_OVERRIDE_RECIPIENT; // tests set this explicitly where needed

const {
  generateEmailToken,
  verifyEmailToken,
  looksLikeEmailToken,
  deriveJti,
} = require('../netlify/functions/_shared/emailAccessToken');
const { isValidAccessToken } = require('../netlify/functions/_shared/orderSecurity');
const {
  EMAIL_TYPES,
  buildOutboxId,
  resolveDelivery,
  enqueueEmail,
  enqueueReservationExpired,
  enqueueFulfillmentEvent,
  ttlForScopes,
  READ_ONLY_TTL_MS,
  ACTION_TTL_MS,
} = require('../netlify/functions/_shared/emailOutbox');
const {
  getIdempotencySafeWindowMs,
  RESEND_IDEMPOTENCY_SAFE_WINDOW_MS,
  backoffMsForAttempt,
  BACKOFF_MS,
  MAX_ATTEMPTS,
  LEASE_DURATION_MS,
} = require('../netlify/functions/_shared/emailProcessorConfig');
const {
  ipIdentifier,
  emailIdentifier,
  checkInquiryRateLimit,
  IP_MAX_PER_WINDOW,
  EMAIL_MAX_PER_WINDOW,
} = require('../netlify/functions/_shared/inquiryRateLimit');
const { ResendSendError } = require('../netlify/functions/_shared/resendClient');
const { claim, handleSendFailure, buildOrderLink } = require('../netlify/functions/process-email-outbox');

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
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    console.error('  FAIL  ' + name + '\n        ' + (err.stack || err.message));
    process.exitCode = 1;
  }
}

/* ---------------------------------------------------------------------
   Mock Firestore — just enough surface for enqueueEmail/claim/
   checkInquiryRateLimit to run against, entirely in memory.
--------------------------------------------------------------------- */

function ts(ms) {
  return { toMillis: () => ms };
}

function makeStore() {
  return new Map();
}

function makeRef(store, collectionName, id) {
  const key = `${collectionName}/${id}`;
  return {
    id,
    _key: key,
    get: async () => {
      const data = store.get(key);
      return { exists: data !== undefined, data: () => data };
    },
    update: async (patch) => {
      store.set(key, { ...(store.get(key) || {}), ...patch });
    },
  };
}

function makeMockDb(store) {
  return {
    collection: (name) => ({
      doc: (id) => makeRef(store, name, id || `auto-${Math.random().toString(36).slice(2)}`),
    }),
    runTransaction: async (fn) => {
      const tx = {
        get: async (ref) => ref.get(),
        set: (ref, data) => store.set(ref._key, data),
        update: (ref, patch) => store.set(ref._key, { ...(store.get(ref._key) || {}), ...patch }),
      };
      return fn(tx);
    },
  };
}

function fakeTx(store) {
  return {
    get: async (ref) => ref.get(),
    set: (ref, data) => store.set(ref._key, data),
    update: (ref, patch) => store.set(ref._key, { ...(store.get(ref._key) || {}), ...patch }),
  };
}

/* =====================================================================
   emailAccessToken.js — deterministic, scoped, tamper-evident tokens
   ===================================================================== */

console.log('\n=== Email access tokens ===');

const CLAIMS_READ = { sc: ['order:read'], iat: Date.now(), exp: Date.now() + 30 * 24 * 60 * 60 * 1000 };
const CLAIMS_ACTION = { sc: ['order:read', 'payment:submit'], iat: CLAIMS_READ.iat, exp: CLAIMS_READ.exp };

test('generateEmailToken is byte-identical across repeated calls with the same input', () => {
  const a = generateEmailToken({ outboxDocId: 'order-created__abc123', orderId: 'abc123', tokenClaims: CLAIMS_READ });
  const b = generateEmailToken({ outboxDocId: 'order-created__abc123', orderId: 'abc123', tokenClaims: CLAIMS_READ });
  assert.strictEqual(a, b, 'same outboxDocId/orderId/tokenClaims must produce the same token every time — required for retry-safe Resend idempotency');
});

test('a different outboxDocId produces a different token (jti derivation actually varies)', () => {
  const a = generateEmailToken({ outboxDocId: 'order-created__abc123', orderId: 'abc123', tokenClaims: CLAIMS_READ });
  const b = generateEmailToken({ outboxDocId: 'order-created__xyz999', orderId: 'abc123', tokenClaims: CLAIMS_READ });
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(deriveJti('order-created__abc123'), deriveJti('order-created__xyz999'));
});

test('token shape always contains a "." and never matches the primary 64-hex token shape', () => {
  const t = generateEmailToken({ outboxDocId: 'x', orderId: 'o1', tokenClaims: CLAIMS_READ });
  assert.ok(looksLikeEmailToken(t));
  assert.ok(t.includes('.'));
  assert.ok(!isValidAccessToken(t), 'an email token must never accidentally validate as a primary token');
});

test('a real primary token (64 hex chars) never looks like an email token', () => {
  const primary = 'a'.repeat(64);
  assert.ok(isValidAccessToken(primary));
  assert.ok(!looksLikeEmailToken(primary));
});

test('verifyEmailToken round-trips: correct orderId/scopes, required scope present', () => {
  const t = generateEmailToken({ outboxDocId: 'payment-submitted__ord1__att1', orderId: 'ord1', tokenClaims: CLAIMS_ACTION });
  const v = verifyEmailToken(t, 'payment:submit');
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.orderId, 'ord1');
  assert.deepStrictEqual(v.scopes, ['order:read', 'payment:submit']);
});

test('verifyEmailToken rejects a scope the token was never granted', () => {
  const t = generateEmailToken({ outboxDocId: 'order-created__ord1', orderId: 'ord1', tokenClaims: CLAIMS_READ });
  const v = verifyEmailToken(t, 'payment:submit');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'INSUFFICIENT_SCOPE', 'a read-only link must never be usable to submit a payment');
});

test('verifyEmailToken rejects a tampered signature', () => {
  const t = generateEmailToken({ outboxDocId: 'order-created__ord1', orderId: 'ord1', tokenClaims: CLAIMS_READ });
  const [payloadB64] = t.split('.');
  const forged = payloadB64 + '.' + Buffer.from('not-a-real-signature').toString('base64url');
  assert.strictEqual(verifyEmailToken(forged, 'order:read').reason, 'BAD_SIGNATURE');
});

test('verifyEmailToken rejects a payload tampered to change the orderId (signature no longer matches)', () => {
  const t = generateEmailToken({ outboxDocId: 'order-created__ord1', orderId: 'ord1', tokenClaims: CLAIMS_READ });
  const [payloadB64, sigB64] = t.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  payload.oid = 'someone-elses-order';
  const forgedPayloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const forged = forgedPayloadB64 + '.' + sigB64;
  assert.strictEqual(verifyEmailToken(forged, 'order:read').reason, 'BAD_SIGNATURE');
});

test('verifyEmailToken rejects an expired token', () => {
  const expired = { sc: ['order:read'], iat: 1000, exp: 2000 }; // long past
  const t = generateEmailToken({ outboxDocId: 'order-created__ord1', orderId: 'ord1', tokenClaims: expired });
  assert.strictEqual(verifyEmailToken(t, 'order:read').reason, 'EXPIRED');
});

test('verifyEmailToken never throws on garbage input — always a typed rejection', () => {
  for (const bad of [null, undefined, '', 'not-a-token', 'has.a.dot.but.wrong.shape', 'a'.repeat(3000) + '.x', 12345]) {
    const v = verifyEmailToken(bad, 'order:read');
    assert.strictEqual(v.ok, false);
    assert.ok(typeof v.reason === 'string');
  }
});

test('malformed base64 in the payload segment is rejected as MALFORMED, not a crash', () => {
  const v = verifyEmailToken('***not-base64***.' + Buffer.from('sig').toString('base64url'), 'order:read');
  assert.strictEqual(v.ok, false);
});

/* =====================================================================
   emailOutbox.js — deterministic IDs, suppression precedence, snapshot
   ===================================================================== */

console.log('\n=== Outbox: deterministic IDs ===');

test('buildOutboxId joins type + idParts with "__"', () => {
  assert.strictEqual(buildOutboxId('order-created', ['ord1']), 'order-created__ord1');
  assert.strictEqual(buildOutboxId('payment-submitted', ['ord1', 'att1']), 'payment-submitted__ord1__att1');
});

test('buildOutboxId rejects an unknown type', () => {
  assert.throws(() => buildOutboxId('not-a-real-type', ['x']));
});

test('every EMAIL_TYPES key has a template render function wired up (checked against the actual template map)', () => {
  const { RENDERERS } = require('../netlify/functions/_shared/emailTemplates');
  for (const type of Object.keys(EMAIL_TYPES)) {
    assert.ok(typeof RENDERERS[type] === 'function', `no renderer for "${type}"`);
  }
  assert.strictEqual(Object.keys(RENDERERS).length, Object.keys(EMAIL_TYPES).length, 'renderer map and type vocabulary must match 1:1');
});

console.log('\n=== Outbox: resolveDelivery suppression precedence ===');

test('isTest:true suppresses even in LIVE mode with no override configured', () => {
  const r = resolveDelivery({ isTestOrder: true, mode: 'live', intendedRecipientEmail: 'customer@example.com' });
  assert.strictEqual(r.status, 'suppressed_test');
});

test('isTest:true suppresses even in QA mode with an override configured', () => {
  process.env.EMAIL_QA_OVERRIDE_RECIPIENT = 'qa@example.com';
  try {
    const r = resolveDelivery({ isTestOrder: true, mode: 'qa', intendedRecipientEmail: 'customer@example.com' });
    assert.strictEqual(r.status, 'suppressed_test', 'isTest must outrank every mode, unconditionally');
  } finally {
    delete process.env.EMAIL_QA_OVERRIDE_RECIPIENT;
  }
});

test('mode "off" suppresses a real (non-test) order', () => {
  const r = resolveDelivery({ isTestOrder: false, mode: 'off', intendedRecipientEmail: 'customer@example.com' });
  assert.strictEqual(r.status, 'suppressed_disabled');
});

test('mode "qa" WITHOUT an override configured fails SAFE to a terminal suppressed status — never "pending" (which is the only status the processor will ever act on)', () => {
  delete process.env.EMAIL_QA_OVERRIDE_RECIPIENT;
  const r = resolveDelivery({ isTestOrder: false, mode: 'qa', intendedRecipientEmail: 'customer@example.com' });
  assert.strictEqual(r.status, 'suppressed_disabled');
  assert.notStrictEqual(r.status, 'pending', 'a missing QA override must never fall through to an actually-sendable status');
});

test('mode "qa" WITH an override configured redirects to the override, never the real address', () => {
  process.env.EMAIL_QA_OVERRIDE_RECIPIENT = 'qa-inbox@example.com';
  try {
    const r = resolveDelivery({ isTestOrder: false, mode: 'qa', intendedRecipientEmail: 'real-customer@example.com' });
    assert.strictEqual(r.status, 'pending');
    assert.strictEqual(r.effectiveRecipientEmail, 'qa-inbox@example.com');
  } finally {
    delete process.env.EMAIL_QA_OVERRIDE_RECIPIENT;
  }
});

test('mode "live" sends to the real recipient', () => {
  const r = resolveDelivery({ isTestOrder: false, mode: 'live', intendedRecipientEmail: 'real-customer@example.com' });
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(r.effectiveRecipientEmail, 'real-customer@example.com');
});

console.log('\n=== Outbox: enqueueEmail snapshotting + secret exclusion ===');

test('enqueueEmail writes a doc at the exact deterministic ID, and never re-derives it later', () => {
  const store = makeStore();
  const db = makeMockDb(store);
  const tx = fakeTx(store);
  const now = ts(1000000);
  const { outboxId } = enqueueEmail(tx, db, {
    type: 'order-created',
    idParts: ['ord1'],
    orderId: 'ord1',
    intendedRecipientEmail: 'c@example.com',
    payload: { orderNumber: 'BP-ABC123' },
    isTestOrder: false,
    emailSettings: { mode: 'live' },
    now,
  });
  assert.strictEqual(outboxId, 'order-created__ord1');
  assert.ok(store.has('emailOutbox/order-created__ord1'));
});

test('enqueueEmail throws when intendedRecipientEmail is missing — never silently enqueues an unsendable email', () => {
  const store = makeStore();
  const db = makeMockDb(store);
  const tx = fakeTx(store);
  assert.throws(() =>
    enqueueEmail(tx, db, { type: 'order-created', idParts: ['ord1'], orderId: 'ord1', intendedRecipientEmail: '', payload: {}, emailSettings: { mode: 'live' }, now: ts(1) })
  );
});

test('enqueueEmail snapshots fromAddress/siteBaseUrl from env AT CALL TIME, on the document', () => {
  const prevFrom = process.env.EMAIL_FROM;
  const prevSite = process.env.SITE_URL;
  process.env.EMAIL_FROM = 'Buddy Patches <hello@buddypatches.ph>';
  process.env.SITE_URL = 'https://buddypatches.ph';
  try {
    const store = makeStore();
    const db = makeMockDb(store);
    const tx = fakeTx(store);
    enqueueEmail(tx, db, {
      type: 'order-created',
      idParts: ['ord2'],
      orderId: 'ord2',
      intendedRecipientEmail: 'c@example.com',
      payload: {},
      isTestOrder: false,
      emailSettings: { mode: 'live' },
      now: ts(1),
    });
    const doc = store.get('emailOutbox/order-created__ord2');
    assert.strictEqual(doc.fromAddress, 'Buddy Patches <hello@buddypatches.ph>');
    assert.strictEqual(doc.siteBaseUrl, 'https://buddypatches.ph');

    // Now change env AFTER enqueue — the already-written snapshot must not change.
    process.env.EMAIL_FROM = 'Someone Else <changed@example.com>';
    const docAfter = store.get('emailOutbox/order-created__ord2');
    assert.strictEqual(docAfter.fromAddress, 'Buddy Patches <hello@buddypatches.ph>', 'a later env change must never mutate an already-enqueued snapshot');
  } finally {
    if (prevFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = prevFrom;
    if (prevSite === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = prevSite;
  }
});

test('enqueueEmail NEVER writes RESEND_API_KEY / EMAIL_TOKEN_SECRET / RATE_LIMIT_SECRET into the outbox document', () => {
  process.env.RESEND_API_KEY = 'sk_should_never_be_snapshotted_anywhere';
  try {
    const store = makeStore();
    const db = makeMockDb(store);
    const tx = fakeTx(store);
    enqueueEmail(tx, db, {
      type: 'order-created',
      idParts: ['ord3'],
      orderId: 'ord3',
      intendedRecipientEmail: 'c@example.com',
      payload: {},
      isTestOrder: false,
      emailSettings: { mode: 'live' },
      now: ts(1),
    });
    const serialized = JSON.stringify(store.get('emailOutbox/order-created__ord3'));
    assert.ok(!serialized.includes('sk_should_never_be_snapshotted_anywhere'), 'RESEND_API_KEY value leaked into an outbox document');
    assert.ok(!serialized.includes(process.env.EMAIL_TOKEN_SECRET), 'EMAIL_TOKEN_SECRET value leaked into an outbox document');
    assert.ok(!serialized.includes(process.env.RATE_LIMIT_SECRET), 'RATE_LIMIT_SECRET value leaked into an outbox document');
  } finally {
    delete process.env.RESEND_API_KEY;
  }
});

test('tokenClaims is null for admin/inquiry types (scopes:null), non-null for order-linked types', () => {
  const store = makeStore();
  const db = makeMockDb(store);
  const tx = fakeTx(store);

  enqueueEmail(tx, db, { type: 'order-admin-new', idParts: ['ord4'], orderId: 'ord4', intendedRecipientEmail: 'admin@example.com', payload: {}, emailSettings: { mode: 'live' }, now: ts(1) });
  assert.strictEqual(store.get('emailOutbox/order-admin-new__ord4').tokenClaims, null);

  enqueueEmail(tx, db, { type: 'order-created', idParts: ['ord5'], orderId: 'ord5', intendedRecipientEmail: 'c@example.com', payload: {}, emailSettings: { mode: 'live' }, now: ts(5000) });
  const created = store.get('emailOutbox/order-created__ord5');
  assert.ok(created.tokenClaims);
  assert.deepStrictEqual(created.tokenClaims.sc, EMAIL_TYPES['order-created'].scopes);
  assert.strictEqual(created.tokenClaims.iat, 5000);
});

test('ttlForScopes: an action scope anywhere in the list selects the SHORTER (30d) TTL, read-only alone gets 180d', () => {
  assert.strictEqual(ttlForScopes(['order:read']), READ_ONLY_TTL_MS);
  assert.strictEqual(ttlForScopes(['order:read', 'payment:submit']), ACTION_TTL_MS);
  assert.strictEqual(ttlForScopes(['reservation:retry']), ACTION_TTL_MS);
  assert.ok(ACTION_TTL_MS < READ_ONLY_TTL_MS, 'a state-changing link must expire sooner than a pure read link');
});

test('enqueueReservationExpired keyed by the RESERVATION\'S OWN expiresAt, not a transaction-local now — recurrence produces distinct IDs', () => {
  const store = makeStore();
  const db = makeMockDb(store);
  const tx = fakeTx(store);
  const firstExpiry = 1_700_000_000_000;
  const secondExpiry = 1_700_005_000_000; // a later re-reservation's own expiry
  const r1 = enqueueReservationExpired(tx, db, { orderId: 'ordR', reservationExpiresAtMs: firstExpiry, recipientEmail: 'c@example.com', payload: {}, emailSettings: { mode: 'live' }, now: ts(1) });
  const r2 = enqueueReservationExpired(tx, db, { orderId: 'ordR', reservationExpiresAtMs: secondExpiry, recipientEmail: 'c@example.com', payload: {}, emailSettings: { mode: 'live' }, now: ts(2) });
  assert.notStrictEqual(r1.outboxId, r2.outboxId, 'two genuine expiries on the same order (expire -> re-reserve -> expire again) must not collide into one outbox event');
});

test('enqueueFulfillmentEvent maps each valid status to its own type, and rejects an unmapped status', () => {
  const store = makeStore();
  const db = makeMockDb(store);
  const tx = fakeTx(store);
  const expected = { processing: 'fulfillment-processing', ready_for_pickup: 'fulfillment-ready', shipped: 'fulfillment-shipped', completed: 'fulfillment-completed' };
  for (const [status, type] of Object.entries(expected)) {
    const { outboxId } = enqueueFulfillmentEvent(tx, db, { status, orderId: 'ordF', recipientEmail: 'c@example.com', payload: {}, emailSettings: { mode: 'live' }, now: ts(1) });
    assert.strictEqual(outboxId, `${type}__ordF`);
  }
  assert.throws(() => enqueueFulfillmentEvent(tx, db, { status: 'unfulfilled', orderId: 'ordF', recipientEmail: 'c@example.com', payload: {}, emailSettings: { mode: 'live' }, now: ts(1) }));
});

test('a retried request (same orderId/attemptId) computes the SAME outbox ID — the actual duplicate-send guard', () => {
  assert.strictEqual(buildOutboxId('payment-submitted', ['ordX', 'attY']), buildOutboxId('payment-submitted', ['ordX', 'attY']));
});

/* =====================================================================
   emailProcessorConfig.js — the hard-capped idempotency window + backoff
   ===================================================================== */

console.log('\n=== Processor config: idempotency window is hard-capped at 12h ===');

test('with no override env set, the safe window is exactly the 12h constant', () => {
  delete process.env.EMAIL_IDEMPOTENCY_WINDOW_MS_TEST_OVERRIDE;
  assert.strictEqual(getIdempotencySafeWindowMs(), RESEND_IDEMPOTENCY_SAFE_WINDOW_MS);
  assert.strictEqual(RESEND_IDEMPOTENCY_SAFE_WINDOW_MS, 12 * 60 * 60 * 1000);
});

test('a SHORTER override env value is honored (useful for tests, never weakens production)', () => {
  process.env.EMAIL_IDEMPOTENCY_WINDOW_MS_TEST_OVERRIDE = String(5000);
  try {
    assert.strictEqual(getIdempotencySafeWindowMs(), 5000);
  } finally {
    delete process.env.EMAIL_IDEMPOTENCY_WINDOW_MS_TEST_OVERRIDE;
  }
});

test('REGRESSION GUARD: a LONGER override env value (e.g. a mistyped "48 hours") is IGNORED, capped at 12h', () => {
  process.env.EMAIL_IDEMPOTENCY_WINDOW_MS_TEST_OVERRIDE = String(48 * 60 * 60 * 1000);
  try {
    assert.strictEqual(getIdempotencySafeWindowMs(), RESEND_IDEMPOTENCY_SAFE_WINDOW_MS, 'an accidental production misconfiguration must never be able to weaken duplicate-send protection');
  } finally {
    delete process.env.EMAIL_IDEMPOTENCY_WINDOW_MS_TEST_OVERRIDE;
  }
});

test('a non-numeric/garbage override is ignored entirely', () => {
  for (const bad of ['not-a-number', '-100', '0', '']) {
    process.env.EMAIL_IDEMPOTENCY_WINDOW_MS_TEST_OVERRIDE = bad;
    assert.strictEqual(getIdempotencySafeWindowMs(), RESEND_IDEMPOTENCY_SAFE_WINDOW_MS, `bad override value "${bad}" must fail safe to the hardcoded constant`);
  }
  delete process.env.EMAIL_IDEMPOTENCY_WINDOW_MS_TEST_OVERRIDE;
});

console.log('\n=== Processor config: retry backoff + attempt cap ===');

test('backoffMsForAttempt(1..4) matches the documented schedule (1m, 5m, 15m, 60m)', () => {
  assert.deepStrictEqual(BACKOFF_MS, [60000, 300000, 900000, 3600000]);
  for (let i = 1; i <= 4; i++) assert.strictEqual(backoffMsForAttempt(i), BACKOFF_MS[i - 1]);
});

test('backoffMsForAttempt clamps to the last backoff value beyond the schedule length', () => {
  assert.strictEqual(backoffMsForAttempt(10), BACKOFF_MS[BACKOFF_MS.length - 1]);
});

test('MAX_ATTEMPTS is 5, one more than the backoff schedule length (index 0..3 = delay before attempts 2..5)', () => {
  assert.strictEqual(MAX_ATTEMPTS, 5);
  assert.strictEqual(BACKOFF_MS.length, MAX_ATTEMPTS - 1);
});

/* =====================================================================
   inquiryRateLimit.js — HMAC identifiers + dual-counter enforcement
   ===================================================================== */

console.log('\n=== Inquiry rate limiting ===');

test('ipIdentifier/emailIdentifier are deterministic and different for different inputs', () => {
  const evtA = { headers: { 'x-nf-client-connection-ip': '1.2.3.4' } };
  const evtB = { headers: { 'x-nf-client-connection-ip': '5.6.7.8' } };
  assert.strictEqual(ipIdentifier(evtA), ipIdentifier(evtA));
  assert.notStrictEqual(ipIdentifier(evtA), ipIdentifier(evtB));
  assert.notStrictEqual(emailIdentifier('a@example.com'), emailIdentifier('b@example.com'));
  assert.strictEqual(emailIdentifier('A@Example.com'), emailIdentifier('a@example.com'), 'email identifier must be case-insensitive, same as requireEmail\'s normalization');
});

test('the raw IP is never present in the identifier itself', () => {
  const id = ipIdentifier({ headers: { 'x-nf-client-connection-ip': '203.0.113.77' } });
  assert.ok(!id.includes('203.0.113.77'));
  assert.strictEqual(id.length, 64, 'must be a hex-encoded HMAC-SHA256 digest');
});

(async () => {
  await testAsync('checkInquiryRateLimit allows up to IP_MAX_PER_WINDOW then blocks, from the SAME IP with different emails', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const event = { headers: { 'x-nf-client-connection-ip': '9.9.9.9' } };
    const now = ts(1_700_000_000_000);

    for (let i = 0; i < IP_MAX_PER_WINDOW; i++) {
      const { allowed } = await db.runTransaction((tx) => checkInquiryRateLimit(tx, db, { event, email: `unique${i}@example.com`, now }));
      assert.strictEqual(allowed, true, `attempt ${i + 1} should be allowed`);
    }
    const blocked = await db.runTransaction((tx) => checkInquiryRateLimit(tx, db, { event, email: 'oneMoreUnique@example.com', now }));
    assert.strictEqual(blocked.allowed, false, `the (${IP_MAX_PER_WINDOW + 1})th attempt from the same IP within the window must be blocked`);
  });

  await testAsync('checkInquiryRateLimit allows up to EMAIL_MAX_PER_WINDOW then blocks, from DIFFERENT IPs reusing the same email', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const now = ts(1_700_000_000_000);
    const email = 'targeted-victim@example.com';

    for (let i = 0; i < EMAIL_MAX_PER_WINDOW; i++) {
      const event = { headers: { 'x-nf-client-connection-ip': `10.0.0.${i}` } };
      const { allowed } = await db.runTransaction((tx) => checkInquiryRateLimit(tx, db, { event, email, now }));
      assert.strictEqual(allowed, true);
    }
    const event = { headers: { 'x-nf-client-connection-ip': '10.0.0.99' } };
    const blocked = await db.runTransaction((tx) => checkInquiryRateLimit(tx, db, { event, email, now }));
    assert.strictEqual(blocked.allowed, false, 'cycling IPs while reusing one email must still be caught by the email counter');
  });

  await testAsync('a blocked attempt does not consume budget — retrying at the boundary stays blocked, not un-blocked', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const event = { headers: { 'x-nf-client-connection-ip': '8.8.4.4' } };
    const now = ts(1_700_000_000_000);
    for (let i = 0; i < IP_MAX_PER_WINDOW; i++) {
      await db.runTransaction((tx) => checkInquiryRateLimit(tx, db, { event, email: `x${i}@example.com`, now }));
    }
    const first = await db.runTransaction((tx) => checkInquiryRateLimit(tx, db, { event, email: 'blocked1@example.com', now }));
    const second = await db.runTransaction((tx) => checkInquiryRateLimit(tx, db, { event, email: 'blocked2@example.com', now }));
    assert.strictEqual(first.allowed, false);
    assert.strictEqual(second.allowed, false, 'a blocked call must not itself increment the counter it was blocked by');
  });

  /* =====================================================================
     process-email-outbox.js — claim / lease / idempotency-window recovery
     ===================================================================== */

  console.log('\n=== Processor: claim() eligibility, leases, and stale-lease recovery ===');

  await testAsync('claim() returns null for a non-existent document', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const ref = makeRef(store, 'emailOutbox', 'missing');
    const result = await claim(db, ref, ts(1000));
    assert.strictEqual(result, null);
  });

  await testAsync('claim() returns null for a pending doc not yet due', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const key = 'order-created__ordA';
    store.set(`emailOutbox/${key}`, { status: 'pending', nextAttemptAt: ts(5000), attempts: 0 });
    const ref = makeRef(store, 'emailOutbox', key);
    const result = await claim(db, ref, ts(1000)); // now < nextAttemptAt
    assert.strictEqual(result, null);
  });

  await testAsync('claim() claims a due pending doc: sets status sending, sets firstSendAttemptAt for the first time', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const key = 'order-created__ordB';
    store.set(`emailOutbox/${key}`, { status: 'pending', nextAttemptAt: ts(1000), firstSendAttemptAt: null, attempts: 0 });
    const ref = makeRef(store, 'emailOutbox', key);
    const now = ts(2000);
    const result = await claim(db, ref, now);
    assert.ok(result && !result.terminal);
    const doc = store.get(`emailOutbox/${key}`);
    assert.strictEqual(doc.status, 'sending');
    assert.strictEqual(doc.firstSendAttemptAt.toMillis(), 2000);
    assert.strictEqual(doc.leaseExpiresAt.toMillis(), 2000 + LEASE_DURATION_MS);
  });

  await testAsync('claim() ignores a "sending" doc whose lease has not expired yet (another invocation owns it)', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const key = 'order-created__ordC';
    store.set(`emailOutbox/${key}`, { status: 'sending', leaseExpiresAt: ts(5000), firstSendAttemptAt: ts(1000), attempts: 0 });
    const ref = makeRef(store, 'emailOutbox', key);
    const result = await claim(db, ref, ts(2000)); // now < leaseExpiresAt
    assert.strictEqual(result, null);
  });

  await testAsync('claim() recovers a "sending" doc with an EXPIRED lease, and PRESERVES the original firstSendAttemptAt (does not reset the idempotency clock)', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const key = 'order-created__ordD';
    const originalFirstAttempt = 1000;
    store.set(`emailOutbox/${key}`, { status: 'sending', leaseExpiresAt: ts(1500), firstSendAttemptAt: ts(originalFirstAttempt), attempts: 1 });
    const ref = makeRef(store, 'emailOutbox', key);
    const now = ts(2_000_000); // well past the expired lease, but within the 12h safe window
    const result = await claim(db, ref, now);
    assert.ok(result && !result.terminal, 'a stale lease within the safe window must be recoverable, not terminal');
    const doc = store.get(`emailOutbox/${key}`);
    assert.strictEqual(doc.status, 'sending');
    assert.strictEqual(doc.firstSendAttemptAt.toMillis(), originalFirstAttempt, 'recovering a stale lease must never overwrite the original first-attempt timestamp — that timestamp IS the idempotency clock');
  });

  await testAsync('claim() transitions to delivery_unknown, terminal, when a stale lease is recovered PAST the 12h safe window', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const key = 'order-created__ordE';
    const originalFirstAttempt = 0;
    store.set(`emailOutbox/${key}`, { status: 'sending', leaseExpiresAt: ts(1000), firstSendAttemptAt: ts(originalFirstAttempt), attempts: 1 });
    const ref = makeRef(store, 'emailOutbox', key);
    const now = ts(RESEND_IDEMPOTENCY_SAFE_WINDOW_MS + 60_000); // just past the window
    const result = await claim(db, ref, now);
    assert.ok(result && result.terminal === true);
    const doc = store.get(`emailOutbox/${key}`);
    assert.strictEqual(doc.status, 'delivery_unknown');
    assert.strictEqual(doc.leaseExpiresAt, null);
    assert.ok(!/pending|sending|failed/.test(doc.status), 'delivery_unknown must never be re-claimable — it must never match either processor query status set again');
  });

  await testAsync('claim() ignores an already-terminal doc (sent / failed_permanent / delivery_unknown / suppressed_*)', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    for (const status of ['sent', 'failed_permanent', 'delivery_unknown', 'suppressed_test', 'suppressed_disabled']) {
      const key = `order-created__ord_${status}`;
      store.set(`emailOutbox/${key}`, { status, nextAttemptAt: ts(0), leaseExpiresAt: ts(0) });
      const ref = makeRef(store, 'emailOutbox', key);
      const result = await claim(db, ref, ts(999999));
      assert.strictEqual(result, null, `a "${status}" document must never be claimed again`);
    }
  });

  console.log('\n=== Processor: handleSendFailure() backoff + permanent-failure cap ===');

  await testAsync('a failure below MAX_ATTEMPTS schedules a backoff retry, status "failed"', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const key = 'order-created__ordF';
    store.set(`emailOutbox/${key}`, { status: 'sending', attempts: 1 });
    const ref = makeRef(store, 'emailOutbox', key);
    const stats = { failed: 0, failedPermanent: 0 };
    await handleSendFailure(ref, { attempts: 1 }, new ResendSendError('Resend API error 500: boom', { status: 500 }), stats);
    const doc = store.get(`emailOutbox/${key}`);
    assert.strictEqual(doc.status, 'failed');
    assert.strictEqual(doc.attempts, 2);
    assert.strictEqual(doc.nextAttemptAt.toMillis() - Date.now() > 0, true);
    assert.strictEqual(stats.failed, 1);
  });

  await testAsync('the Nth failure (attempts reaching MAX_ATTEMPTS) becomes failed_permanent, never scheduled again', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const key = 'order-created__ordG';
    store.set(`emailOutbox/${key}`, { status: 'sending', attempts: MAX_ATTEMPTS - 1 });
    const ref = makeRef(store, 'emailOutbox', key);
    const stats = { failed: 0, failedPermanent: 0 };
    await handleSendFailure(ref, { attempts: MAX_ATTEMPTS - 1 }, new ResendSendError('Resend API error 400: bad', { status: 400 }), stats);
    const doc = store.get(`emailOutbox/${key}`);
    assert.strictEqual(doc.status, 'failed_permanent');
    assert.strictEqual(doc.attempts, MAX_ATTEMPTS);
    assert.strictEqual(doc.nextAttemptAt, undefined, 'a permanently failed event must not carry a next-attempt time forward');
    assert.strictEqual(stats.failedPermanent, 1);
  });

  await testAsync('a non-ResendSendError (e.g. a template/token bug) is prefixed and length-capped, never stored as the raw error object', async () => {
    const store = makeStore();
    const db = makeMockDb(store);
    const key = 'order-created__ordH';
    store.set(`emailOutbox/${key}`, { status: 'sending', attempts: 0 });
    const ref = makeRef(store, 'emailOutbox', key);
    const stats = { failed: 0, failedPermanent: 0 };
    const longMessage = 'x'.repeat(500);
    const weirdError = new Error(longMessage);
    await handleSendFailure(ref, { attempts: 0 }, weirdError, stats);
    const doc = store.get(`emailOutbox/${key}`);
    assert.ok(doc.lastError.startsWith('Processing error:'));
    assert.ok(typeof doc.lastError === 'string', 'must never store the raw Error object itself');
    assert.ok(doc.lastError.length <= 220, 'must be length-capped (200 chars of message + the fixed prefix)');
  });

  console.log('\n=== Processor: order link construction ===');

  test('buildOrderLink puts the token ONLY in the URL fragment, never the query string', () => {
    const link = buildOrderLink('https://buddypatches.ph', 'abc.def');
    assert.ok(link.includes('#token='), 'token must be in the fragment');
    assert.ok(!link.includes('?token='), 'token must never be in a query string — it would reach server logs/referer headers');
    assert.strictEqual(link, 'https://buddypatches.ph/order.html#token=abc.def');
  });

  test('buildOrderLink strips a trailing slash from siteBaseUrl (no double slash)', () => {
    assert.strictEqual(buildOrderLink('https://buddypatches.ph/', 't'), 'https://buddypatches.ph/order.html#token=t');
  });

  test('buildOrderLink returns null when there is no token (admin/inquiry emails carry no order link)', () => {
    assert.strictEqual(buildOrderLink('https://buddypatches.ph', null), null);
  });

  console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES ABOVE' : ' — all green') + '\n');
})().catch((err) => {
  console.error('UNCAUGHT in async test section:', err);
  process.exitCode = 1;
});
