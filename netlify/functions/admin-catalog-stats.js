/*
 * GET /api/admin-catalog-stats
 *
 * Admin-only. The Dashboard's "At a glance" catalog numbers, and nothing
 * else.
 *
 * ---- Why this exists ----
 * The Dashboard previously called admin-list-products + admin-list-patches
 * + admin-list-collections just to render four counts and a list of
 * out-of-stock titles. Those three endpoints exist for the CATALOG EDITOR:
 * they read every document in each collection and return full records
 * (patches/collections literally spread the whole document). Doing that on
 * every Dashboard load meant three full-collection reads, growing with the
 * catalog, to produce numbers that fit on one line.
 *
 * This endpoint answers the same questions far more cheaply:
 *   - patches and collections use count() AGGREGATIONS — Firestore counts
 *     server-side and downloads ZERO documents.
 *   - products still needs per-variant stock to find out-of-stock items,
 *     which no aggregation can express, so it reads products with a
 *     .select() PROJECTION — pulling only title/active/variants and
 *     skipping description, gallery, customizationConfig and thumbnails,
 *     which are the large fields.
 *
 * READ-ONLY. No writes, no commerce logic, no catalog mutation.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { createTimer } = require('./_shared/timing');
const { fetchCatalogStats } = require('./_shared/dashboardStats');

exports.handler = withErrorHandling(async (event) => {
  const timer = createTimer();

  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event, timer);
  if (!auth.ok) return fail(auth.status, auth.error);

  // Same implementation admin-dashboard.js uses.
  const stats = await timer.time('queryMs', () => fetchCatalogStats(getDb()));

  return ok({ ...stats, _timing: timer.summary() });
});
