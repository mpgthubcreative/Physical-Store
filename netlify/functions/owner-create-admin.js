/*
 * POST /api/owner-create-admin
 *
 * Owner-only. Creates a new Admin team member — { email, password }. Buddy
 * has no transactional email yet (Resend arrives in a later phase), so
 * unlike an invite-link flow, the Owner sets an initial password directly
 * and shares it with the new Admin out of band; the new Admin should change
 * it after first sign-in. The plaintext password is never stored anywhere —
 * Firebase Auth hashes it internally and this function never persists or
 * logs it.
 *
 * role is always 'admin' here — there is no role selector. Owner is only
 * ever created through the one-time local scripts/set-admin-claim.js, never
 * through an HTTP endpoint.
 */
const { admin, getDb, getAdminAuth } = require('./_shared/firebaseAdmin');
const { requireOwner } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { ValidationError, requireEmail, requireString } = require('./_shared/validation');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');

  const authResult = await requireOwner(event);
  if (!authResult.ok) return fail(authResult.status, authResult.error);

  const body = JSON.parse(event.body || '{}');
  const email = requireEmail(body.email);
  const password = requireString(body.password, 'Temporary password', { maxLength: 200 });
  if (password.length < 8) throw new ValidationError('Temporary password must be at least 8 characters.');

  const auth = getAdminAuth();
  let userRecord;
  try {
    userRecord = await auth.createUser({ email, password, disabled: false });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      throw new ValidationError('An account with this email already exists.');
    }
    throw err;
  }

  await auth.setCustomUserClaims(userRecord.uid, { admin: true, role: 'admin' });

  const db = getDb();
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection('adminUsers').doc(userRecord.uid).set({
    uid: userRecord.uid,
    email,
    role: 'admin',
    status: 'active',
    createdAt: now,
    createdBy: authResult.uid,
    updatedAt: now,
    updatedBy: authResult.uid,
  });

  return ok({ uid: userRecord.uid });
});
