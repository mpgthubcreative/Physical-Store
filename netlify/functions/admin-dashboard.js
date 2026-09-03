/*
 * GET /api/admin-dashboard?preset=&startDate=&endDate=&includeTest=
 *
 * Owner AND Admin (requireAdmin). READ-ONLY — no writes, no commerce logic.
 *
 * ---- Why this endpoint exists ----
 * The Dashboard previously issued three authenticated calls in parallel:
 * admin-report, admin-order-stats and admin-catalog-stats. Measured on
 * production they returned in ~3.71s, ~3.66s and ~3.67s with response
 * bodies of roughly 609 B, 256 B and 172 B. Three unrelated queries taking
 * near-identical time while returning almost nothing is not a query
 * problem — it is a fixed per-invocation cost being paid three times.
 *
 * That cost is per Lambda INSTANCE, and Netlify gives each function its own:
 *   - loading firebase-admin, which pulls in @google-cloud/firestore
 *     (~1s to require even on a fast local machine, slower on a Lambda)
 *   - constructing the Firestore gRPC client and opening its channel
 *   - verifyIdToken's first call, which fetches Google's public signing keys
 *   - the adminUsers/{uid} status read
 *
 * Running them as one function pays that once instead of three times, and
 * the three Firestore reads still run concurrently inside it — so the
 * Firestore portion is max(a,b,c), not a+b+c.
 *
 * ---- No duplicated business logic ----
 * Everything here comes from the same modules the standalone endpoints use:
 * resolveRange + fetchReportOrders + buildSummary from the reporting layer,
 * and fetchOrderStats + fetchCatalogStats from _shared/dashboardStats.js.
 * This file only orchestrates; it defines nothing.
 *
 * ---- Catalog must never delay the operational view ----
 * Catalog stats are the lowest-priority part of this payload. They are
 * wrapped so a failure or slowness there resolves to null rather than
 * failing the whole response — the Dashboard then simply renders without
 * the "At a glance" numbers and can fetch them separately. Payments to
 * review, orders to fulfil and the report always come back.
 *
 * ---- _timing ----
 * The response carries a small `_timing` object (stage names and
 * milliseconds only — never a token, uid, email or customer field) so
 * before/after latency can be compared from DevTools without log access.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireAdminCached } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { createTimer } = require('./_shared/timing');
const { resolveRange } = require('./_shared/reportRange');
const { fetchReportOrders, buildSummary, MAX_REPORT_ORDERS } = require('./_shared/reportData');
const { fetchOrderStats, fetchCatalogStats } = require('./_shared/dashboardStats');

exports.handler = withErrorHandling(async (event) => {
  const timer = createTimer();

  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  // ONE authentication and ONE adminUsers status check for the whole
  // Dashboard, instead of three.
  const auth = await requireAdminCached(event, timer);
  if (!auth.ok) return fail(auth.status, auth.error);

  const params = event.queryStringParameters || {};
  const includeTest = params.includeTest === 'true';
  const skipCatalog = params.skipCatalog === 'true';

  const range = resolveRange({
    preset: params.preset,
    startDate: params.startDate,
    endDate: params.endDate,
  });

  const db = getDb();

  // The three reads run concurrently: total Firestore time is the slowest
  // one, not the sum.
  const [reportResult, orderStats, catalogStats] = await timer.time('firestoreConcurrentMs', () =>
    Promise.all([
      fetchReportOrders(db, { startUtcMs: range.startUtcMs, endUtcMs: range.endUtcMs, includeTest }, admin),
      fetchOrderStats(db),
      // Lowest priority: never allowed to fail or stall the operational
      // payload. Null here simply means the UI omits the catalog tiles.
      skipCatalog
        ? Promise.resolve(null)
        : fetchCatalogStats(db).catch((err) => {
            console.error('catalog stats failed (dashboard continues):', err.message);
            return null;
          }),
    ])
  );

  const { orders, truncated, testOrderCount, fetchedCount } = reportResult;
  const summary = buildSummary(orders);

  return ok({
    // --- Priority 1: what needs action right now (never date-filtered) ---
    orderStats,

    // --- Priority 2: the date-scoped report ---
    range: {
      preset: range.preset,
      startDate: range.startDate,
      endDate: range.endDate,
      label: range.label,
      spanDays: range.spanDays,
      generatedAt: range.generatedAtManila,
    },
    includeTest,
    summary,
    orders,
    meta: {
      testOrdersInRange: includeTest ? 0 : testOrderCount,
      fetchedCount,
      truncated,
      maxOrders: MAX_REPORT_ORDERS,
    },

    // --- Priority 3: catalog, null if it failed or was skipped ---
    catalogStats,

    _timing: { ...timer.summary(), authStatusCacheHit: auth.cacheHit },
  });
});
