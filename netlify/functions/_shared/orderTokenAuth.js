/*
 * Unified order lookup for the two token formats a customer-facing order
 * endpoint (get-order.js, submit-payment.js, reserve-order.js) may now
 * receive:
 *
 *   - the PRIMARY order-access token — 64 hex chars, generated client-side
 *     at checkout, verified by comparing its SHA-256 hash against
 *     order.accessTokenHash (see _shared/orderSecurity.js). This is
 *     unchanged from Phase 5D and earlier.
 *
 *   - an EMAIL access token — always contains a '.', generated server-side
 *     by the scheduled processor at send time (see
 *     _shared/emailAccessToken.js), carrying its own orderId and a scoped
 *     permission list. Introduced in Phase 5E so a transactional email's
 *     link can work without ever holding a raw primary token.
 *
 * Every caller passes the ONE scope it actually needs
 * ('order:read' | 'payment:submit' | 'reservation:retry') — an email token
 * missing that scope is rejected here, before the caller sees any order
 * data at all. The primary token is unscoped (it grants everything a
 * customer could already do from the order page), so requiredScope is
 * simply ignored on that path.
 *
 * Pass `tx` when calling from inside a Firestore transaction so the
 * lookup participates in that transaction's reads (required by Firestore's
 * reads-before-writes rule) instead of issuing an independent read.
 */
const { isValidAccessToken, hashToken, hashesMatch } = require('./orderSecurity');
const { looksLikeEmailToken, verifyEmailToken } = require('./emailAccessToken');

async function resolveOrderByToken(db, rawToken, requiredScope, { tx = null } = {}) {
  const read = (target) => (tx ? tx.get(target) : target.get());

  if (looksLikeEmailToken(rawToken)) {
    const verified = verifyEmailToken(rawToken, requiredScope);
    if (!verified.ok) return { ok: false, reason: verified.reason };

    const ref = db.collection('orders').doc(verified.orderId);
    const snap = await read(ref);
    if (!snap.exists) return { ok: false, reason: 'NOT_FOUND' };
    return { ok: true, ref, doc: snap, order: snap.data(), via: 'email' };
  }

  if (isValidAccessToken(rawToken)) {
    const hash = hashToken(rawToken);
    const query = db.collection('orders').where('accessTokenHash', '==', hash).limit(1);
    const snap = await read(query);
    if (snap.empty) return { ok: false, reason: 'NOT_FOUND' };

    const doc = snap.docs[0];
    const order = doc.data();
    if (!hashesMatch(hash, order.accessTokenHash)) return { ok: false, reason: 'NOT_FOUND' };
    return { ok: true, ref: doc.ref, doc, order, via: 'primary' };
  }

  return { ok: false, reason: 'MALFORMED' };
}

/** Generous enough for the longest realistic email token (JSON payload + HMAC signature, both base64url) while still bounded — actual shape is re-validated by looksLikeEmailToken/isValidAccessToken regardless. */
const TOKEN_FIELD_MAX_LENGTH = 600;

module.exports = { resolveOrderByToken, TOKEN_FIELD_MAX_LENGTH };
