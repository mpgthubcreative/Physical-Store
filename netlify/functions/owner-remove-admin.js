/*
 * POST /api/owner-remove-admin
 *
 * Owner-only. Permanently removes a team member's Firebase Auth account and
 * adminUsers/{uid} doc — { uid }. Requires the member to already be
 * disabled first, mirroring the archive-then-delete lifecycle used
 * everywhere else in Buddy (Products, Patches, Collections): Active ->
 * Disable -> Reactivate OR Remove permanently.
 *
 * Historical attribution is preserved on purpose: any product/patch/
 * collection recording this uid in createdBy/updatedBy keeps that uid
 * string untouched — removing the account here doesn't touch that data, it
 * just means the uid no longer resolves to a live account.
 *
 * The Owner account can never be a target — role is read from our own
 * adminUsers record, never trusted from the request body.
 */
const { getDb, getAdminAuth } = require('./_shared/firebaseAdmin');
const { requireOwner } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireString } = require('./_shared/validation');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const authResult = await requireOwner(event);
  if (!authResult.ok) return fail(authResult.status, authResult.error);

  const body = JSON.parse(event.body || '{}');
  const uid = requireString(body.uid, 'uid', { maxLength: 128 });

  const db = getDb();
  const ref = db.collection('adminUsers').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return fail(404, 'Team member not found.');

  const member = snap.data();
  if (member.role === 'owner') throw new ValidationError('The Owner account cannot be removed.');
  if (member.status !== 'disabled') {
    throw new ValidationError('This team member must be disabled before their access can be removed.');
  }

  await ref.delete();

  const auth = getAdminAuth();
  const warnings = [];
  try {
    await auth.deleteUser(uid);
  } catch (err) {
    warnings.push('Team member record removed, but the Firebase Auth account could not be deleted.');
  }

  return ok({ uid, warnings });
});
