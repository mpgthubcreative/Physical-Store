/*
 * POST /api/owner-disable-admin
 *
 * Owner-only. Disables an Admin's access — { uid }. Two things happen:
 *
 *  1. Firebase Auth: disabled:true (blocks all future sign-ins/token
 *     refreshes) + revokeRefreshTokens (invalidates their current session
 *     immediately, so an already-open tab can't keep working).
 *  2. adminUsers/{uid}.status = 'disabled' — this is what actually makes an
 *     already-issued, not-yet-expired ID token stop working against admin
 *     APIs immediately: _shared/adminAuth.js checks this on every request
 *     instead of paying for a live Auth-backend call per request.
 *
 * Historical data the disabled Admin created (createdBy/updatedBy fields on
 * products/patches/collections) is left untouched — this only affects
 * their own ability to sign in and act.
 *
 * The Owner account can never be a target here — role is read from our own
 * adminUsers record, never trusted from the request body. Since this
 * project supports exactly one Owner (see scripts/set-admin-claim.js), that
 * check alone guarantees a Team operation can never leave zero active
 * Owners.
 */
const { admin, getDb, getAdminAuth } = require('./_shared/firebaseAdmin');
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
  if (member.role === 'owner') throw new ValidationError('The Owner account cannot be disabled.');

  const auth = getAdminAuth();
  await auth.updateUser(uid, { disabled: true });
  await auth.revokeRefreshTokens(uid);

  await ref.update({
    status: 'disabled',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: authResult.uid,
  });

  return ok({ uid });
});
