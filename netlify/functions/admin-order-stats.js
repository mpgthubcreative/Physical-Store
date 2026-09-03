/*
 * GET /api/admin-order-stats
 *
 * Admin-only. Lightweight operational counters for the Admin dashboard —
 * uses Firestore's count() aggregation (server-side count, no documents
 * downloaded) rather than fetching the whole `orders` collection just to
 * count it.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { fetchOrderStats } = require('./_shared/dashboardStats');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  // Same implementation admin-dashboard.js uses — one definition of what
  // counts as "to review" and "to fulfil".
  const stats = await fetchOrderStats(getDb());

  return ok(stats);
});
