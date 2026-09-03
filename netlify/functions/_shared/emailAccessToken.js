/*
 * Stateless, HMAC-signed, scoped email-access tokens.
 *
 * ---- Why this exists ----
 * The primary orderAccessToken (see _shared/orderSecurity.js) is generated
 * client-side and the server only ever stores its hash — by design, the
 * server can never reconstruct its raw form. Under scheduled-only email
 * sending, the processor runs long after any request that could have held
 * a raw primary token, so email links need an entirely separate credential
 * that the SERVER can legitimately produce on its own, at send time.
 *
 * This token is that credential. It is:
 *   - SEPARATE from the primary token — never the same value, never stored
 *     as a substitute for it, and the primary token's own verification path
 *     (accessTokenHash lookup) is completely untouched by this module.
 *   - STATELESS — nothing is persisted to grant or later validate it. The
 *     signature IS the proof; there is no database row that "is" this
 *     token. Nothing here ever writes to Firestore.
 *   - SCOPED — carries an explicit, minimal set of permissions (e.g.
 *     ['order:read'] vs ['order:read','payment:submit']). Every consuming
 *     endpoint (get-order.js, submit-payment.js, reserve-order.js) must
 *     pass its OWN required scope to verifyEmailToken() and is rejected if
 *     that scope isn't present — a "your order shipped" link can never be
 *     used to submit a payment reference.
 *   - DETERMINISTIC per outbox event. Every claim (scopes, issued-at,
 *     expiry, and the token id) is derived from data already stored on the
 *     emailOutbox document, never from Date.now()/crypto.randomBytes() at
 *     generation time. Regenerating the token for the same outbox event
 *     produces the BYTE-IDENTICAL string every time — required so a
 *     retried send uses the same Resend idempotency key AND the same
 *     request payload (Resend's own duplicate-send protection needs both
 *     to match, not just the key).
 *
 * ---- Format ----
 *   payload = { v:1, oid, sc, iat, exp, jti }
 *   token   = base64url(JSON.stringify(payload)) + '.' + base64url(HMAC-SHA256(payloadB64, EMAIL_TOKEN_SECRET))
 *
 * `jti` is not stored anywhere — it's re-derived every time from the
 * outbox document's own immutable ID via a second HMAC, so it's stable
 * without needing a field for it.
 *
 * ---- Format disambiguation from the primary token ----
 * The primary token is exactly 64 lowercase hex characters (32 random
 * bytes). An email token always contains a '.'. Endpoints check shape
 * first (isValidAccessToken vs looksLikeEmailToken) and route to the
 * correct verification path — never both, never a wasted lookup.
 *
 * ---- Revocation ----
 * No per-token revocation lookup in V1 (that would cost a Firestore read
 * on every verification — exactly the cost Phase 5D.3 spent significant
 * effort removing). The coarse lever is rotating EMAIL_TOKEN_SECRET, which
 * invalidates every outstanding email-issued token globally without
 * touching the primary token at all — a real, documented emergency step,
 * not a code feature. Exposure is otherwise bounded by scope-appropriate
 * expiry (see _shared/emailOutbox.js's TTL constants).
 */
const crypto = require('crypto');

const TOKEN_VERSION = 1;

function getSecret() {
  const secret = process.env.EMAIL_TOKEN_SECRET;
  if (!secret) {
    throw new Error('EMAIL_TOKEN_SECRET environment variable is not set.');
  }
  return secret;
}

function hmacSha256(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

/** Deterministically derives this token's `jti` from the outbox document's own stable ID — never stored, never random. */
function deriveJti(outboxDocId) {
  return crypto.createHmac('sha256', getSecret()).update(String(outboxDocId)).digest('hex').slice(0, 24);
}

/**
 * Builds the token for one outbox event. `tokenClaims` must be the exact
 * `{ sc, iat, exp }` object already stored on that outbox document at
 * enqueue time — never freshly computed here — so this produces the same
 * string on every call for the same outboxDocId/orderId/tokenClaims.
 */
function generateEmailToken({ outboxDocId, orderId, tokenClaims }) {
  if (!outboxDocId || !orderId || !tokenClaims || !Array.isArray(tokenClaims.sc)) {
    throw new Error('generateEmailToken requires outboxDocId, orderId, and tokenClaims{sc,iat,exp}.');
  }
  const payload = {
    v: TOKEN_VERSION,
    oid: orderId,
    sc: tokenClaims.sc,
    iat: tokenClaims.iat,
    exp: tokenClaims.exp,
    jti: deriveJti(outboxDocId),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = hmacSha256(payloadB64, getSecret()).toString('base64url');
  return `${payloadB64}.${signature}`;
}

// The primary orderAccessToken is exactly 64 hex chars (see orderSecurity.js's
// ACCESS_TOKEN_RE) and never contains a '.'. An email token always does.
const EMAIL_TOKEN_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function looksLikeEmailToken(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 2000 && EMAIL_TOKEN_SHAPE_RE.test(raw);
}

/**
 * Verifies a raw email token and enforces `requiredScope`.
 *
 * Returns { ok:true, orderId, scopes, jti } or { ok:false, reason }, where
 * reason is one of MALFORMED | BAD_SIGNATURE | EXPIRED | INSUFFICIENT_SCOPE
 * | CONFIG. Never throws for a bad/forged token — only CONFIG (secret not
 * set) indicates a server misconfiguration rather than an invalid token.
 */
function verifyEmailToken(raw, requiredScope) {
  if (!looksLikeEmailToken(raw)) return { ok: false, reason: 'MALFORMED' };

  const dotIndex = raw.indexOf('.');
  const payloadB64 = raw.slice(0, dotIndex);
  const sigB64 = raw.slice(dotIndex + 1);

  let secret;
  try {
    secret = getSecret();
  } catch (err) {
    return { ok: false, reason: 'CONFIG' };
  }

  let providedSig;
  let expectedSig;
  try {
    providedSig = Buffer.from(sigB64, 'base64url');
    expectedSig = hmacSha256(payloadB64, secret);
  } catch (err) {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (err) {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (
    !payload ||
    payload.v !== TOKEN_VERSION ||
    typeof payload.oid !== 'string' ||
    !Array.isArray(payload.sc) ||
    typeof payload.exp !== 'number' ||
    typeof payload.iat !== 'number'
  ) {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (Date.now() > payload.exp) return { ok: false, reason: 'EXPIRED' };

  if (requiredScope && !payload.sc.includes(requiredScope)) {
    return { ok: false, reason: 'INSUFFICIENT_SCOPE' };
  }

  return { ok: true, orderId: payload.oid, scopes: payload.sc, jti: payload.jti };
}

module.exports = { generateEmailToken, verifyEmailToken, looksLikeEmailToken, deriveJti };
