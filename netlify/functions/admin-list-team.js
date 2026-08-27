/*
 * GET /api/admin-list-team
 *
 * Owner-only. Returns every adminUsers row for the Team page. Reads
 * adminUsers directly rather than calling the Firebase Auth Admin API per
 * row, so this stays a single Firestore read regardless of team size.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { requireOwner } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireOwner(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const db = getDb();
  const snap = await db.collection('adminUsers').get();
  const members = snap.docs
    .map((doc) => {
      const d = doc.data();
      return {
        uid: doc.id,
        email: d.email,
        role: d.role,
        status: d.status,
        createdAt: d.createdAt || null,
      };
    })
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === 'owner' ? -1 : 1;
      return (a.email || '').localeCompare(b.email || '');
    });

  return ok({ members });
});
