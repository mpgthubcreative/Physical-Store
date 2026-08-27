/*
 * POST /api/owner-reactivate-admin
 *
 * Owner-only. Reverses owner-disable-admin.js — { uid }. Restores Firebase
 * Auth sign-in and flips adminUsers/{uid}.status back to 'active'. Also
 * defensively re-asserts the admin:true/role:'admin' custom claims — disable
 * never actually strips them, but restating them here is cheap and keeps
 * this endpoint correct even if that ever changes.
 *
 * The Owner account can never be a target — role is read from our own
 * adminUsers record, never trusted from the request body.
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
  if (member.role === 'owner') throw new ValidationError('The Owner account does not need reactivation.');

  const auth = getAdminAuth();
  await auth.updateUser(uid, { disabled: false });
  await auth.setCustomUserClaims(uid, { admin: true, role: 'admin' });

  await ref.update({
    status: 'active',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: authResult.uid,
  });

  return ok({ uid });
});
