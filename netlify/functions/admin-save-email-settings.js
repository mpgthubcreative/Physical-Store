/*
 * POST /api/admin-save-email-settings
 *
 * OWNER ONLY (requireOwner) — the email mode controls whether the store
 * sends any mail at all and, in 'live' mode, to real customer addresses.
 * Same tier as the checkout master switch and payment settings.
 *
 * ---- Structural fail-safes, not just validation ----
 * Setting mode:'qa' is REFUSED unless EMAIL_QA_OVERRIDE_RECIPIENT is
 * currently set — there is no point being in "QA mode" with nowhere to
 * redirect mail to.
 *
 * Setting mode:'live' is REFUSED if EMAIL_QA_OVERRIDE_RECIPIENT is STILL
 * set — this is the fail-safe your review specifically required: it must
 * be structurally impossible to activate real customer email while a QA
 * override remains configured, not just documented as a step someone
 * might forget. The only way past this check is actually removing that
 * environment variable and redeploying.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireOwner } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireOneOf } = require('./_shared/validation');
const { VALID_MODES } = require('./_shared/emailSettings');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const auth = await requireOwner(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const body = JSON.parse(event.body || '{}');
  const mode = requireOneOf(body.mode, 'mode', VALID_MODES);

  const qaOverrideConfigured = !!(process.env.EMAIL_QA_OVERRIDE_RECIPIENT || '').trim();

  if (mode === 'qa' && !qaOverrideConfigured) {
    throw new ValidationError('Cannot switch to QA mode: EMAIL_QA_OVERRIDE_RECIPIENT is not set in Netlify environment variables. Set it and redeploy first.');
  }
  if (mode === 'live' && qaOverrideConfigured) {
    throw new ValidationError('Cannot switch to LIVE mode: EMAIL_QA_OVERRIDE_RECIPIENT is still set. Remove it from Netlify environment variables and redeploy before going live.');
  }

  const db = getDb();
  await db.collection('settings').doc('email').set(
    { mode, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: auth.uid },
    { merge: true }
  );

  return ok({ saved: true, mode });
});
