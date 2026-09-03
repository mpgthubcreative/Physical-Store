/*
 * GET /api/admin-list-team
 *
 * Owner-only. Returns every adminUsers row for the Team page.
 *
 * Also cross-checks each row's Firestore role/status against that user's
 * ACTUAL live Firebase Auth custom claims (a small, bounded N of
 * auth.getUser() calls — team rosters are never large, so this doesn't
 * become an N+1 problem at any realistic scale). The two are supposed to
 * always agree, but they're independent systems written in separate calls
 * (setCustomUserClaims vs a Firestore write) — a partial failure between
 * those two calls (e.g. a bootstrap script that wrote the Firestore doc but
 * whose claims call didn't land) can silently leave a Firestore row saying
 * "active Admin" while the account actually has no admin claim at all and
 * every real request 403s. `claimsMatch: false` surfaces exactly that
 * drift so it never has to be diagnosed via decoded JWTs again.
 */
const { getDb, getAdminAuth } = require('./_shared/firebaseAdmin');
const { requireOwnerCached } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireOwnerCached(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const db = getDb();
  const adminAuth = getAdminAuth();
  const snap = await db.collection('adminUsers').get();

  const members = await Promise.all(
    snap.docs.map(async (doc) => {
      const d = doc.data();
      let claimsMatch = null;
      try {
        const userRecord = await adminAuth.getUser(doc.id);
        const claims = userRecord.customClaims || {};
        claimsMatch = claims.admin === true && claims.role === d.role;
      } catch (err) {
        // Firebase Auth account missing entirely (e.g. deleted outside the
        // Team flow) — surfaced as a mismatch rather than a thrown error.
        claimsMatch = false;
      }
      return {
        uid: doc.id,
        email: d.email,
        role: d.role,
        status: d.status,
        createdAt: d.createdAt || null,
        claimsMatch,
      };
    })
  );

  members.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'owner' ? -1 : 1;
    return (a.email || '').localeCompare(b.email || '');
  });

  return ok({ members, _timing: { authStatusCacheHit: auth.cacheHit } });
});
