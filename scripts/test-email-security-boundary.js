/*
 * OFFLINE STATIC SECURITY-BOUNDARY TEST — no Firebase credentials, no
 * network. Phase 5E (Resend + Transactional Emails).
 *
 * Reads the actual source of the email-related functions and asserts
 * invariants that a behavioral unit test can't reach because they're
 * about what the code NEVER does — the same static-source-check style as
 * scripts/test-server-authority.js. A regression here (someone
 * "helpfully" reading EMAIL_FROM at send time instead of the snapshot, or
 * wiring the mode-save endpoint to requireAdmin instead of requireOwner)
 * would be caught by these, not by a code review alone.
 *
 * Usage: node scripts/test-email-security-boundary.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const FN = (name) => fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', name), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

/* =====================================================================
   Email Mode: Owner-only to change, Owner+Admin to view
   ===================================================================== */

console.log('\n=== Static: Email Mode permission split ===');

test('admin-save-email-settings.js is OWNER-only', () => {
  const src = strip(FN('admin-save-email-settings.js'));
  assert.ok(src.includes('requireOwner'), 'must call requireOwner');
  assert.ok(!/requireAdmin\(/.test(src), 'must never authorize with requireAdmin instead');
});

test('admin-get-email-settings.js allows Owner AND Admin to view', () => {
  const src = strip(FN('admin-get-email-settings.js'));
  assert.ok(src.includes('requireAdmin'), 'must call requireAdmin (Owner passes requireAdmin too)');
});

test('admin-save-email-settings.js structurally refuses QA mode without an override configured', () => {
  const src = strip(FN('admin-save-email-settings.js'));
  assert.ok(/mode === 'qa' && !qaOverrideConfigured/.test(src), 'must check this, not just document it');
});

test('admin-save-email-settings.js structurally refuses LIVE mode WHILE a QA override is still configured', () => {
  const src = strip(FN('admin-save-email-settings.js'));
  assert.ok(/mode === 'live' && qaOverrideConfigured/.test(src), 'the one real fail-safe required by the architecture review — must be code, not a comment');
});

test('admin-get-email-settings.js never returns a raw secret value, only presence booleans', () => {
  const src = strip(FN('admin-get-email-settings.js'));
  for (const secretEnv of ['RESEND_API_KEY', 'EMAIL_TOKEN_SECRET', 'RATE_LIMIT_SECRET']) {
    const re = new RegExp(`:\\s*process\\.env\\.${secretEnv}(?!\\s*[,)])`);
    assert.ok(!re.test(src.replace(/!!process\.env\.\w+/g, '')), `${secretEnv} must only ever appear behind !! (boolean presence), never returned as a value`);
  }
  assert.ok(src.includes('maskEmail'), 'the QA override address must be masked, not returned in full to every Admin');
});

/* =====================================================================
   emailSettings.js: fails closed
   ===================================================================== */

console.log('\n=== Static: email mode fails closed ===');

test('getEmailSettings defaults to mode "off" when the doc is missing', () => {
  const src = strip(FN('_shared/emailSettings.js'));
  assert.ok(/DEFAULT_EMAIL_SETTINGS\s*=\s*\{\s*mode:\s*'off'\s*\}/.test(src));
  assert.ok(/if \(!snap\.exists\) return \{ \.\.\.DEFAULT_EMAIL_SETTINGS \}/.test(src));
});

test('getEmailSettings falls back to "off" for any unrecognized stored value, never trusts it verbatim', () => {
  const src = strip(FN('_shared/emailSettings.js'));
  assert.ok(/VALID_MODES\.includes\(data\.mode\)\s*\?\s*data\.mode\s*:\s*'off'/.test(src));
});

/* =====================================================================
   emailOutbox.js: suppression can never be bypassed by a caller
   ===================================================================== */

console.log('\n=== Static: suppression is decided ONCE, centrally, and cannot be overridden by a caller ===');

const outboxSrc = FN('_shared/emailOutbox.js');
const outboxCode = strip(outboxSrc);

test('resolveDelivery, not any per-event wrapper, is the sole place that decides status/effectiveRecipientEmail', () => {
  // Every enqueue* wrapper must funnel through enqueueEmail (which calls
  // resolveDelivery) rather than ever assigning its own status/recipient.
  const wrapperNames = [
    'enqueueOrderCreated', 'enqueuePaymentSubmitted', 'enqueuePaymentRejected', 'enqueuePaymentApproved',
    'enqueueReservationExpired', 'enqueueFulfillmentEvent', 'enqueueAdminNewOrder', 'enqueueAdminPaymentReview',
    'enqueueEventInquiryAdmin', 'enqueueEventInquiryCustomer',
  ];
  for (const name of wrapperNames) {
    const fnMatch = outboxCode.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
    assert.ok(fnMatch, `could not locate ${name}`);
    assert.ok(fnMatch[1].includes('enqueueEmail('), `${name} must delegate to enqueueEmail, never write status/effectiveRecipientEmail itself`);
    assert.ok(!/status\s*:/.test(fnMatch[1]), `${name} must never set its own status`);
  }
});

test('isTest is checked FIRST in resolveDelivery, before mode is even inspected', () => {
  const fn = outboxCode.match(/function resolveDelivery\([^)]*\)\s*\{([\s\S]*?)\n\}/)[1];
  const isTestIdx = fn.indexOf('isTestOrder');
  const modeIdx = fn.indexOf("mode === 'off'");
  assert.ok(isTestIdx >= 0 && modeIdx >= 0 && isTestIdx < modeIdx, 'isTest must be checked before any mode branch — it must outrank every mode unconditionally');
});

test('the QA branch reads EMAIL_QA_OVERRIDE_RECIPIENT itself — never trusts a caller-supplied override', () => {
  const fn = outboxCode.match(/function resolveDelivery\([^)]*\)\s*\{([\s\S]*?)\n\}/)[1];
  assert.ok(fn.includes("process.env.EMAIL_QA_OVERRIDE_RECIPIENT"), 'must read the env var directly inside resolveDelivery');
});

console.log('\n=== Static: emailOutbox.js never persists a secret ===');

for (const secretEnv of ['RESEND_API_KEY', 'EMAIL_TOKEN_SECRET', 'RATE_LIMIT_SECRET']) {
  test(`_shared/emailOutbox.js never references ${secretEnv}`, () => {
    assert.ok(!outboxCode.includes(secretEnv), `found ${secretEnv} referenced in emailOutbox.js — secrets must never be snapshotted into a Firestore document`);
  });
}

test('enqueueEmail snapshots fromAddress/siteBaseUrl from env AT ENQUEUE TIME (into the tx.set payload), not left for the processor to resolve', () => {
  const fn = outboxCode.match(/function enqueueEmail\([^)]*\)\s*\{([\s\S]*?)\n\}/)[1];
  assert.ok(/fromAddress:\s*process\.env\.EMAIL_FROM/.test(fn));
  assert.ok(/siteBaseUrl:\s*process\.env\.SITE_URL/.test(fn));
});

console.log('\n=== Static: the primary access token is never stored raw, anywhere in this module ===');

test('_shared/emailOutbox.js never writes a raw access token field, only tokenClaims (scope/iat/exp)', () => {
  assert.ok(!/rawToken|accessToken\s*:/.test(outboxCode), 'must never persist a raw token value');
  assert.ok(outboxCode.includes('tokenClaims'), 'must persist only the claims needed to regenerate the token deterministically later');
});

/* =====================================================================
   process-email-outbox.js: the ONLY caller of Resend; snapshot-only sends
   ===================================================================== */

console.log('\n=== Static: process-email-outbox.js is the ONLY place that calls Resend ===');

const processorSrc = FN('process-email-outbox.js');
const processorCode = strip(processorSrc);

test('process-email-outbox.js is the only function file that imports resendClient.js', () => {
  const dir = path.join(__dirname, '..', 'netlify', 'functions');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const importers = files.filter((f) => strip(fs.readFileSync(path.join(dir, f), 'utf8')).includes("require('./_shared/resendClient')"));
  assert.deepStrictEqual(importers, ['process-email-outbox.js'], 'no commerce/inquiry endpoint may call Resend directly — only the scheduled processor may, so a Resend outage can never affect a customer-facing request');
});

test('no commerce/inquiry endpoint requires resendClient.js even indirectly by name', () => {
  const dir = path.join(__dirname, '..', 'netlify', 'functions');
  for (const f of ['create-order.js', 'submit-payment.js', 'admin-approve-payment.js', 'admin-reject-payment.js', 'admin-update-fulfillment.js', 'submit-event-inquiry.js']) {
    const src = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(!src.includes('resendClient'), `${f} must never touch Resend directly`);
    assert.ok(!src.includes('sendEmail('), `${f} must never call sendEmail directly`);
  }
});

test('the processor sends using ONLY the snapshotted fields (data.effectiveRecipientEmail/fromAddress), never re-reading EMAIL_FROM/EMAIL_QA_OVERRIDE_RECIPIENT at send time', () => {
  assert.ok(!processorCode.includes('process.env.EMAIL_FROM'), 'must not re-read EMAIL_FROM — use the snapshot');
  assert.ok(!processorCode.includes('process.env.SITE_URL'), 'must not re-read SITE_URL — use the snapshot');
  assert.ok(!processorCode.includes('process.env.EMAIL_QA_OVERRIDE_RECIPIENT'), 'must not re-read the QA override — use the snapshot');
  assert.ok(!processorCode.includes("getEmailSettings("), 'must not re-read the current email mode — use emailModeAtEnqueue already baked into the snapshot');
  assert.ok(/to:\s*data\.effectiveRecipientEmail/.test(processorCode));
  assert.ok(/from:\s*data\.fromAddress/.test(processorCode));
});

test('the processor reads secrets (RESEND_API_KEY via resendClient, EMAIL_TOKEN_SECRET via emailAccessToken) fresh from env — the one necessary exception, since secrets are never snapshotted', () => {
  assert.ok(processorCode.includes("require('./_shared/resendClient')"));
  assert.ok(processorCode.includes("require('./_shared/emailAccessToken')"));
});

test('the processor uses the Idempotency-Key header set to the outbox document\'s own deterministic ID', () => {
  assert.ok(/idempotencyKey:\s*docSnap\.id/.test(processorCode));
});

test('the processor never queries or touches suppressed_test / suppressed_disabled documents', () => {
  assert.ok(!/suppressed_test|suppressed_disabled/.test(processorCode), 'these statuses must be permanently terminal at enqueue time — the processor should never even reference them');
});

test('claim() checks the idempotency-safe window via the shared config getter, never a locally hardcoded number', () => {
  const fn = processorCode.match(/async function claim\([^)]*\)\s*\{([\s\S]*?)\n\}/)[1];
  assert.ok(fn.includes('getIdempotencySafeWindowMs('), 'must use the shared, hard-capped getter');
  assert.ok(fn.includes('delivery_unknown'), 'must transition to delivery_unknown when the window has passed');
  assert.ok(fn.includes('LEASE_DURATION_MS'), 'lease length must come from the shared config, not a magic number');
});

test('handleSendFailure() caps permanent failure at the shared MAX_ATTEMPTS constant, and uses the shared backoff schedule', () => {
  const fn = processorCode.match(/async function handleSendFailure\([^)]*\)\s*\{([\s\S]*?)\n\}/)[1];
  assert.ok(fn.includes('MAX_ATTEMPTS'));
  assert.ok(fn.includes('backoffMsForAttempt('));
  assert.ok(fn.includes('failed_permanent'));
});

/* =====================================================================
   Token scope enforcement wired correctly at each customer endpoint
   ===================================================================== */

console.log('\n=== Static: each customer endpoint enforces its OWN least-privilege scope ===');

const SCOPE_BY_ENDPOINT = {
  'get-order.js': 'order:read',
  'submit-payment.js': 'payment:submit',
  'reserve-order.js': 'reservation:retry',
};

for (const [file, scope] of Object.entries(SCOPE_BY_ENDPOINT)) {
  test(`${file} requires the '${scope}' scope, not a broader one`, () => {
    const src = strip(FN(file));
    assert.ok(src.includes('resolveOrderByToken('), `${file} must use the shared token resolver`);
    assert.ok(src.includes(`'${scope}'`), `${file} must pass its own required scope ('${scope}') to resolveOrderByToken`);
  });
}

test('resolveOrderByToken enforces requiredScope only on the EMAIL token path — the primary token stays unscoped (it already grants everything the order page can do)', () => {
  const src = strip(FN('_shared/orderTokenAuth.js'));
  assert.ok(/verifyEmailToken\(rawToken,\s*requiredScope\)/.test(src));
});

test('resolveOrderByToken disambiguates by SHAPE (looksLikeEmailToken first), never tries both paths for one token', () => {
  const src = strip(FN('_shared/orderTokenAuth.js'));
  const emailBranchIdx = src.indexOf('looksLikeEmailToken(rawToken)');
  const primaryBranchIdx = src.indexOf('isValidAccessToken(rawToken)');
  assert.ok(emailBranchIdx >= 0 && primaryBranchIdx >= 0 && emailBranchIdx < primaryBranchIdx);
});

/* =====================================================================
   Lifecycle integration: enqueue calls exist at every locked call site
   ===================================================================== */

console.log('\n=== Static: every locked lifecycle email is actually wired at its call site ===');

const EXPECTED_ENQUEUE_CALLS = {
  'create-order.js': ['enqueueOrderCreated(', 'enqueueAdminNewOrder('],
  'submit-payment.js': ['enqueuePaymentSubmitted(', 'enqueueAdminPaymentReview(', 'enqueueReservationExpired('],
  'admin-approve-payment.js': ['enqueuePaymentApproved('],
  'admin-reject-payment.js': ['enqueuePaymentRejected('],
  'admin-update-fulfillment.js': ['enqueueFulfillmentEvent('],
  'inventory-cleanup-expired-reservations.js': ['enqueueReservationExpired('],
  'submit-event-inquiry.js': ['enqueueEventInquiryAdmin(', 'enqueueEventInquiryCustomer('],
};

for (const [file, calls] of Object.entries(EXPECTED_ENQUEUE_CALLS)) {
  for (const call of calls) {
    test(`${file} calls ${call}`, () => {
      assert.ok(strip(FN(file)).includes(call), `expected ${file} to call ${call}`);
    });
  }
}

test('every commerce/inquiry endpoint reads email settings with tx (getEmailSettings(db, tx)), never a bare read outside the transaction', () => {
  for (const file of Object.keys(EXPECTED_ENQUEUE_CALLS)) {
    const src = strip(FN(file));
    if (!src.includes('getEmailSettings(')) continue; // inventory-cleanup calls it too; all listed files should
    assert.ok(/getEmailSettings\(db,\s*tx\)/.test(src), `${file} must read email settings via the transaction (reads-before-writes)`);
  }
});

test('payment/inventory/shipping/fulfillment core logic is untouched — approve still consumes the reservation, reject still reactivates it, submit still locks it', () => {
  assert.ok(strip(FN('admin-approve-payment.js')).includes('consumeReservation('));
  assert.ok(strip(FN('admin-reject-payment.js')).includes('reactivateReservation('));
  assert.ok(strip(FN('submit-payment.js')).includes('lockReservation('));
  assert.ok(strip(FN('create-order.js')).includes('reserveInventory('));
});

/* =====================================================================
   Events inquiry: honeypot + rate limiting are both actually wired
   ===================================================================== */

console.log('\n=== Static: Events inquiry anti-abuse is actually wired, not just documented ===');

test('submit-event-inquiry.js checks the honeypot BEFORE any real validation runs', () => {
  const src = strip(FN('submit-event-inquiry.js'));
  const honeypotIdx = src.indexOf('body.website');
  const validationIdx = src.indexOf('requireString(body.name');
  assert.ok(honeypotIdx >= 0 && validationIdx >= 0 && honeypotIdx < validationIdx);
});

test('submit-event-inquiry.js calls the shared HMAC rate limiter, not an ad-hoc check', () => {
  const src = strip(FN('submit-event-inquiry.js'));
  assert.ok(src.includes("require('./_shared/inquiryRateLimit')"));
  assert.ok(src.includes('checkInquiryRateLimit('));
});

test('submit-event-inquiry.js never reads a client-supplied timing/honeypot-defeat value as a security signal', () => {
  const src = strip(FN('submit-event-inquiry.js'));
  assert.ok(!/body\.(timeSinceRender|formOpenedAt|renderedAt|elapsedMs)/.test(src), 'must never trust a client-supplied timing value for anti-abuse');
});

console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES ABOVE' : ' — all green') + '\n');
