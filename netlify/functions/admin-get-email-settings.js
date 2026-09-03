/*
 * GET /api/admin-get-email-settings
 *
 * Owner AND Admin may READ. Only Owner may change the mode
 * (admin-save-email-settings.js). `canChangeMode` tells the UI whether to
 * show the mode controls as interactive or read-only — that is UX only;
 * the save endpoint independently re-checks with requireOwner().
 *
 * Never returns a secret value. RESEND_API_KEY / EMAIL_TOKEN_SECRET /
 * RATE_LIMIT_SECRET are reported only as booleans ("is this configured at
 * all"), never their contents. EMAIL_QA_OVERRIDE_RECIPIENT is reported as
 * a boolean plus a masked hint (first character of the local part only,
 * full domain) — enough for an Owner glancing at this page to recognize
 * "yes that's my test inbox" without fully exposing the address to every
 * Admin who can view this page.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { getEmailSettings } = require('./_shared/emailSettings');

function maskEmail(raw) {
  const trimmed = String(raw || '').trim();
  const at = trimmed.indexOf('@');
  if (at <= 0) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at);
  return `${local[0]}${'*'.repeat(Math.max(local.length - 1, 3))}${domain}`;
}

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const db = getDb();
  const [emailSettings, deliveryIssues] = await Promise.all([
    getEmailSettings(db),
    // Single-field 'in' filter — no composite index required, same
    // reasoning as every other count() aggregation in this app.
    db.collection('emailOutbox').where('status', 'in', ['failed_permanent', 'delivery_unknown']).count().get(),
  ]);

  const qaOverrideRaw = (process.env.EMAIL_QA_OVERRIDE_RECIPIENT || '').trim();

  return ok({
    mode: emailSettings.mode,
    canChangeMode: auth.role === 'owner',
    config: {
      resendApiKeyConfigured: !!process.env.RESEND_API_KEY,
      emailFromConfigured: !!process.env.EMAIL_FROM,
      emailFromDisplay: process.env.EMAIL_FROM || null, // the public sender identity — safe to show
      siteUrlConfigured: !!process.env.SITE_URL,
      emailTokenSecretConfigured: !!process.env.EMAIL_TOKEN_SECRET,
      rateLimitSecretConfigured: !!process.env.RATE_LIMIT_SECRET,
      adminNotificationEmailConfigured: !!process.env.ADMIN_NOTIFICATION_EMAIL,
    },
    qaOverride: {
      configured: !!qaOverrideRaw,
      maskedHint: qaOverrideRaw ? maskEmail(qaOverrideRaw) : null,
    },
    deliveryIssuesCount: deliveryIssues.data().count,
  });
});
