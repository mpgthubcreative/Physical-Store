/*
 * Rate limiting for the public Events & Parties inquiry endpoint.
 *
 * ---- Why HMAC, not plain SHA-256, of the IP ----
 * IPv4 address space is small and fully enumerable (~4 billion values) —
 * an unsalted hash of an IP is not meaningful pseudonymization; a rainbow
 * table over the entire space is a trivial offline computation. Every
 * identifier here is HMAC-SHA256'd with RATE_LIMIT_SECRET (a server-only
 * secret, never the same as EMAIL_TOKEN_SECRET — different purpose,
 * independent rotation), which makes the stored value useless without the
 * secret. The raw IP is never stored anywhere, even transiently.
 *
 * ---- Two independent counters ----
 * IP-based: blunts a single source hammering the form.
 * Email-based: blunts the same actor cycling IPs but reusing one address
 * (or targeting one victim's inbox with repeated "someone submitted an
 * inquiry as you" spam).
 * Both must pass for a submission to proceed.
 *
 * ---- What this is NOT ----
 * Not a CAPTCHA, not a WAF. Genuinely real controls here are: server-side
 * field validation, the honeypot field (structural — bots fill fields
 * humans never see), and these two HMAC-keyed counters. A client-supplied
 * "time since form render" value is deliberately NOT used as a security
 * boundary anywhere in this module or its caller — it's trivially forgeable
 * client-side and is at most a weak heuristic, never gating logic here.
 */
const crypto = require('crypto');

const IP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const IP_MAX_PER_WINDOW = 5;

const EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const EMAIL_MAX_PER_WINDOW = 3;

function getSecret() {
  const secret = process.env.RATE_LIMIT_SECRET;
  if (!secret) {
    throw new Error('RATE_LIMIT_SECRET environment variable is not set.');
  }
  return secret;
}

function hmacIdentifier(rawValue) {
  return crypto.createHmac('sha256', getSecret()).update(rawValue).digest('hex');
}

/** Best-effort caller IP from Netlify's own forwarded header. Never persisted raw — only its HMAC ever reaches storage. */
function extractClientIp(event) {
  const header = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['X-NF-Client-Connection-IP'])) || '';
  return header.trim() || 'unknown';
}

function ipIdentifier(event) {
  return hmacIdentifier(extractClientIp(event));
}

function emailIdentifier(rawEmail) {
  return hmacIdentifier(String(rawEmail || '').trim().toLowerCase());
}

/**
 * Checks BOTH the IP and email counters. Both must pass. Records a hit
 * against both on success; records nothing if either is already at its
 * limit (so a blocked attempt doesn't itself consume budget).
 */
async function checkInquiryRateLimit(tx, db, { event, email, now }) {
  const ipId = ipIdentifier(event);
  const emailId = emailIdentifier(email);

  // Both checks must be evaluated before either is recorded — Firestore
  // transactions require all reads before any writes, so read-check both
  // first, then write both only if both are allowed.
  const ipWindowStart = Math.floor(now.toMillis() / IP_WINDOW_MS) * IP_WINDOW_MS;
  const emailWindowStart = Math.floor(now.toMillis() / EMAIL_WINDOW_MS) * EMAIL_WINDOW_MS;
  const ipRef = db.collection('inquiryRateLimits').doc(`ip_${ipId}_${ipWindowStart}`);
  const emailRef = db.collection('inquiryRateLimits').doc(`email_${emailId}_${emailWindowStart}`);

  const [ipSnap, emailSnap] = await Promise.all([tx.get(ipRef), tx.get(emailRef)]);
  const ipCount = ipSnap.exists ? Number(ipSnap.data().count) || 0 : 0;
  const emailCount = emailSnap.exists ? Number(emailSnap.data().count) || 0 : 0;

  if (ipCount >= IP_MAX_PER_WINDOW || emailCount >= EMAIL_MAX_PER_WINDOW) {
    return { allowed: false };
  }

  tx.set(ipRef, { kind: 'ip', hmacId: ipId, windowStart: ipWindowStart, count: ipCount + 1, updatedAt: now }, { merge: false });
  tx.set(emailRef, { kind: 'email', hmacId: emailId, windowStart: emailWindowStart, count: emailCount + 1, updatedAt: now }, { merge: false });

  return { allowed: true };
}

module.exports = {
  IP_WINDOW_MS,
  IP_MAX_PER_WINDOW,
  EMAIL_WINDOW_MS,
  EMAIL_MAX_PER_WINDOW,
  ipIdentifier,
  emailIdentifier,
  extractClientIp,
  checkInquiryRateLimit,
};
