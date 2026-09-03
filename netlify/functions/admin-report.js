/*
 * GET /api/admin-report?preset=&startDate=&endDate=&includeTest=
 *
 * Owner AND Admin (requireAdmin) — reporting is a normal management task,
 * not a financial-configuration privilege. Owner keeps its exclusive rights
 * over payment settings and the checkout switch; those live in
 * admin-save-payment-settings.js and are unaffected by this endpoint.
 *
 * READ-ONLY. This endpoint performs no writes of any kind. It reads order
 * snapshots and returns aggregates — it never alters payment, inventory,
 * reservation or fulfillment state, and never recalculates a historical
 * order's stored pricing.
 *
 * All range resolution happens SERVER-SIDE in Asia/Manila
 * (_shared/reportRange.js). The browser sends a preset name or two
 * YYYY-MM-DD strings; it never sends timestamps, and its clock/timezone is
 * never trusted to decide what "today" means.
 *
 * `includeTest` defaults to FALSE. Test orders are excluded from every
 * figure unless the caller explicitly opts in — see _shared/reportData.js
 * for why that filtering happens in memory rather than in the query.
 *
 * Firestore cost: one range query on createdAt, served by the automatic
 * single-field index. No composite index is required by this endpoint.
 */
const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireAdminCached } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { createTimer } = require('./_shared/timing');
const { resolveRange } = require('./_shared/reportRange');
const { fetchReportOrders, buildSummary, MAX_REPORT_ORDERS } = require('./_shared/reportData');

exports.handler = withErrorHandling(async (event) => {
  const timer = createTimer();

  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdminCached(event, timer);
  if (!auth.ok) return fail(auth.status, auth.error);

  const params = event.queryStringParameters || {};

  // Only the literal string 'true' opts in. Anything else — absent, '1',
  // 'false', garbage — means exclude test orders. Fails closed so a
  // malformed request can never quietly inflate revenue.
  const includeTest = params.includeTest === 'true';

  const range = resolveRange({
    preset: params.preset,
    startDate: params.startDate,
    endDate: params.endDate,
  });

  const db = getDb();
  const { orders, truncated, testOrderCount, fetchedCount } = await timer.time('queryMs', () =>
    fetchReportOrders(db, { startUtcMs: range.startUtcMs, endUtcMs: range.endUtcMs, includeTest }, admin)
  );

  const summary = buildSummary(orders);

  return ok({
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
      // How many test orders sit inside this range, so the UI can show
      // "N test orders hidden" rather than leaving the exclusion invisible.
      testOrdersInRange: includeTest ? 0 : testOrderCount,
      fetchedCount,
      truncated,
      maxOrders: MAX_REPORT_ORDERS,
    },
    _timing: { ...timer.summary(), authStatusCacheHit: auth.cacheHit },
  });
});
