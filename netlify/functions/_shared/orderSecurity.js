/*
 * Order-number generation, access-token validation/hashing, and request
 * fingerprinting for idempotent order creation.
 *
 * The order-access token itself is generated in the BROWSER (crypto-random,
 * 32 bytes) — never by the server — specifically so a client retrying an
 * idempotent create-order call already holds its own token and never needs
 * the server to "recover" one. The server only ever validates its format
 * and stores its SHA-256 hash; the raw token is never logged, never
 * persisted, and never appears in a URL query string (see get-order.js,
 * which is POST-only for this reason).
 */
const crypto = require('crypto');

// Excludes visually ambiguous characters (0/O, 1/I) — same alphabet Luna
// Shop uses for its own order numbers.
const ORDER_NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ORDER_NUMBER_LENGTH = 6;
const ORDER_NUMBER_PREFIX = 'BP-';

const ACCESS_TOKEN_RE = /^[0-9a-f]{64}$/; // 32 random bytes, hex-encoded
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9-]{8,100}$/;

function generateOrderNumberCandidate() {
  const bytes = crypto.randomBytes(ORDER_NUMBER_LENGTH);
  let suffix = '';
  for (let i = 0; i < ORDER_NUMBER_LENGTH; i++) {
    suffix += ORDER_NUMBER_ALPHABET[bytes[i] % ORDER_NUMBER_ALPHABET.length];
  }
  return ORDER_NUMBER_PREFIX + suffix;
}

function isValidAccessToken(token) {
  return typeof token === 'string' && ACCESS_TOKEN_RE.test(token);
}

function isValidIdempotencyKey(key) {
  return typeof key === 'string' && IDEMPOTENCY_KEY_RE.test(key);
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/** Constant-time comparison, used as defense-in-depth after a lookup-by-hash. */
function hashesMatch(hashA, hashB) {
  if (typeof hashA !== 'string' || typeof hashB !== 'string') return false;
  const bufA = Buffer.from(hashA, 'hex');
  const bufB = Buffer.from(hashB, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/*
 * Deterministic fingerprint of "what the customer is trying to order" —
 * used to detect an idempotencyKey being reused for a genuinely different
 * request (which must be rejected, never silently served the old order).
 * Built from an explicit, ordered field list rather than JSON.stringify of
 * the raw payload, so key insertion order in the request body can never
 * change the fingerprint.
 */
function computeRequestFingerprint({ customer, deliveryMethod, deliveryAddress, orderNotes, items }) {
  const normalizedItems = (items || []).map((item) => ({
    productId: item.productId,
    variantId: item.variantId,
    quantity: item.quantity,
    personalization: item.personalization
      ? { text: item.personalization.text, x: item.personalization.x, y: item.personalization.y, z: item.personalization.z }
      : null,
    patches: (item.patches || []).map((p) => ({ patchId: p.patchId, x: p.x, y: p.y, z: p.z })),
  }));

  const canonical = JSON.stringify({
    fullName: customer?.fullName || '',
    email: (customer?.email || '').toLowerCase(),
    mobile: customer?.mobile || '',
    deliveryMethod: deliveryMethod || '',
    deliveryAddress: deliveryAddress || null,
    orderNotes: orderNotes || '',
    items: normalizedItems,
  });

  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = {
  generateOrderNumberCandidate,
  isValidAccessToken,
  isValidIdempotencyKey,
  hashToken,
  hashesMatch,
  computeRequestFingerprint,
};
