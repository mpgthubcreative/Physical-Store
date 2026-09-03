/*
 * Thin wrapper around Resend's REST API. Plain fetch() — no SDK dependency;
 * Resend's send call is one simple POST, not worth a new package for.
 *
 * ---- Idempotency ----
 * Every call MUST be given an `idempotencyKey` — always the outbox
 * document's own deterministic ID (see _shared/emailOutbox.js). Resend
 * deduplicates identical requests sharing a key within its own retention
 * window (see _shared/emailProcessorConfig.js for how this app reasons
 * about that window's edge). This is layer 3 of this app's three-layer
 * duplicate-send protection — the outbox document's deterministic ID
 * (layer 1) and the processor's claim-before-send transaction (layer 2)
 * both exist upstream of this call.
 *
 * ---- Error sanitization happens AT THE SOURCE, not after the fact ----
 * sanitizeSendError() builds a clean, storable message from ONLY the HTTP
 * status and Resend's own `message` field (truncated). It never touches
 * response headers, the full response body, the request body, or the API
 * key. This is deliberately narrow rather than trying to redact an
 * arbitrary caught error after capturing everything about it — the
 * resulting message is safe to write into emailOutbox.lastError, which is
 * itself readable via the Admin Email Settings failure count.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

class ResendSendError extends Error {
  constructor(sanitizedMessage, { status, retryable } = {}) {
    super(sanitizedMessage);
    this.name = 'ResendSendError';
    this.status = status || null;
    this.retryable = retryable !== false; // default true unless explicitly marked otherwise
  }
}

function sanitizeSendError(status, body) {
  const rawMessage = body && typeof body.message === 'string' ? body.message : null;
  const safeMessage = rawMessage ? rawMessage.slice(0, 200) : 'Unknown error';
  return `Resend API error ${status || '(no status)'}: ${safeMessage}`;
}

/**
 * Sends one email via Resend.
 *
 * @param idempotencyKey  the outbox document's deterministic ID
 * @param to              a single recipient address (this app never sends to multiple recipients)
 * @param from             e.g. "Buddy Patches <hello@buddypatches.ph>"
 * @param subject
 * @param html
 * @returns { messageId }
 * @throws ResendSendError with a sanitized message on any non-2xx response or network failure
 */
async function sendEmail({ idempotencyKey, to, from, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable is not set.');
  }
  if (!idempotencyKey) {
    throw new Error('sendEmail: idempotencyKey is required.');
  }

  let res;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
  } catch (err) {
    // Network-level failure (DNS, timeout, connection reset) — never
    // includes the request itself, just a generic class of error.
    throw new ResendSendError('Network error contacting Resend.', { retryable: true });
  }

  let body = {};
  try {
    body = await res.json();
  } catch (err) {
    // Non-JSON response body — proceed with an empty object; the status
    // code alone is still meaningful.
  }

  if (!res.ok) {
    // 4xx errors other than 429 are typically permanent (bad recipient,
    // bad from-address, malformed request) — still allowed to retry under
    // the normal backoff schedule since the processor's attempt cap
    // handles that either way, but flagged as non-retryable is reserved
    // for a future refinement; for V1 every failure follows the same
    // backoff.
    throw new ResendSendError(sanitizeSendError(res.status, body), { status: res.status, retryable: true });
  }

  return { messageId: body.id || null };
}

module.exports = { sendEmail, sanitizeSendError, ResendSendError };
