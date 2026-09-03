/*
 * POST /api/submit-event-inquiry
 *
 * PUBLIC. Persists an Events & Parties booking inquiry and enqueues two
 * emails (admin notification + customer acknowledgment) inside the SAME
 * transaction that creates the inquiry record — the identical
 * transactional-outbox guarantee every commerce endpoint gets (see
 * _shared/emailOutbox.js's module comment for the full explanation of
 * what that guarantee actually is).
 *
 * ---- Anti-abuse, in the order applied ----
 *   1. Honeypot: `website` is a hidden field real visitors never see or
 *      fill (see events.html/js/events.js). A non-empty value is treated
 *      as a bot — the response is the SAME fake-success shape a genuine
 *      submission gets, so the trap is never revealed, but nothing is
 *      persisted and nothing is enqueued.
 *   2. Field validation — name/email required, phone/comment optional,
 *      all length-bounded.
 *   3. HMAC-keyed rate limiting (_shared/inquiryRateLimit.js) — both an
 *      IP-based counter and an email-based counter must pass. Unlike the
 *      honeypot, a genuine rate-limited caller gets an HONEST 429 — the
 *      thresholds (5 per 10 min per IP, 3 per 24h per email) are generous
 *      enough that a real visitor hitting one is rare, and silently
 *      swallowing a real person's inquiry would be worse than telling
 *      them to slow down.
 * A client-supplied "how long was the form open" value is deliberately
 * NEVER read or trusted anywhere in this file — see inquiryRateLimit.js's
 * own module comment for why.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { withErrorHandling, ok, fail, json } = require('./_shared/response');
const { requireString, optionalString, requireEmail } = require('./_shared/validation');
const { checkInquiryRateLimit } = require('./_shared/inquiryRateLimit');
const { getEmailSettings } = require('./_shared/emailSettings');
const { enqueueEventInquiryAdmin, enqueueEventInquiryCustomer } = require('./_shared/emailOutbox');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const body = JSON.parse(event.body || '{}');

  // Checked before any real validation runs, so a bot that fills every
  // field still costs this endpoint the least possible work.
  if (String(body.website || '').trim() !== '') {
    return ok({ submitted: true });
  }

  const name = requireString(body.name, 'Name', { maxLength: 100 });
  const email = requireEmail(body.email);
  const phone = optionalString(body.phone, 'Phone', { maxLength: 30 });
  const comment = optionalString(body.comment, 'Comment', { maxLength: 2000 });

  const db = getDb();

  const result = await db.runTransaction(async (tx) => {
    const now = admin.firestore.Timestamp.now();

    // Read BEFORE any write in this transaction (Firestore's reads-
    // before-writes rule) — checkInquiryRateLimit() below writes when it
    // allows the request through.
    const emailSettings = await getEmailSettings(db, tx);

    const { allowed } = await checkInquiryRateLimit(tx, db, { event, email, now });
    if (!allowed) return { ok: false, rateLimited: true };

    const inquiryRef = db.collection('eventInquiries').doc();
    tx.set(inquiryRef, {
      name,
      email,
      phone: phone || null,
      comment: comment || null,
      createdAt: now,
    });

    const adminEmail = (process.env.ADMIN_NOTIFICATION_EMAIL || '').trim();
    if (adminEmail) {
      enqueueEventInquiryAdmin(tx, db, {
        inquiryId: inquiryRef.id,
        adminEmail,
        payload: { name, email, phone: phone || null, comment: comment || null },
        emailSettings,
        now,
      });
    }
    enqueueEventInquiryCustomer(tx, db, {
      inquiryId: inquiryRef.id,
      recipientEmail: email,
      payload: { name },
      emailSettings,
      now,
    });

    return { ok: true };
  });

  if (!result.ok) {
    return json(429, { error: 'Too many inquiries from this address recently. Please try again later, or contact us directly.' });
  }

  return ok({ submitted: true });
});
