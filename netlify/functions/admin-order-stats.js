/*
 * GET /api/admin-order-stats
 *
 * Admin-only. Lightweight operational counters for the Admin dashboard —
 * uses Firestore's count() aggregation (server-side count, no documents
 * downloaded) rather than fetching the whole `orders` collection just to
 * count it.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { requireAdminCached } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { createTimer } = require('./_shared/timing');
const { fetchOrderStats } = require('./_shared/dashboardStats');

exports.handler = withErrorHandling(async (event) => {
  const timer = createTimer();

  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdminCached(event, timer);
  if (!auth.ok) return fail(auth.status, auth.error);

  // Same implementation admin-dashboard.js uses — one definition of what
  // counts as "to review" and "to fulfil".
  const stats = await timer.time('queryMs', () => fetchOrderStats(getDb()));

  return ok({ ...stats, _timing: { ...timer.summary(), authStatusCacheHit: auth.cacheHit } });
});
