/*
 * GET /api/admin-benchmark-firestore-grpc
 *
 * TEMPORARY DIAGNOSTIC ENDPOINT — half of a fair, order-independent
 * transport comparison. Its counterpart is
 * admin-benchmark-firestore-rest.js. Together they replace
 * admin-benchmark-firestore-transport.js (deprecated — see that file),
 * whose single-invocation gRPC-then-REST ordering could not separate "REST
 * is faster" from "running second after warming is faster."
 *
 * This endpoint touches ONLY the default (gRPC) Firestore client — never
 * the isolated REST client — so a genuinely cold invocation of THIS
 * endpoint measures gRPC's real first-call cost with no possible
 * contamination from a REST call earlier in the same process.
 *
 * Same shape as production's real admin-list-products.js: auth status read
 * first (the real first Firestore call of the invocation, exactly as
 * requireAdmin() performs it in the live app), products query second — so
 * the numbers this produces are directly comparable to production
 * behavior, not an artificial microbenchmark.
 *
 * Owner AND Admin, requireAdmin — fresh, uncached, same reasoning as the
 * deprecated endpoint: an internal diagnostic tool gets the strictest
 * check, and it isn't part of any daily workflow page.
 *
 * Privacy: returns only timings and a document count — never adminUsers
 * document contents, product content, or a token.
 *
 * DELETE THIS FILE once the transport question is settled.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { createTimer } = require('./_shared/timing');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const timer = createTimer();

  // requireAdmin() itself performs the FIRST Firestore call of this
  // invocation (the adminUsers/{uid} status read) via the default gRPC
  // client, timed as 'authStatusReadMs'. Nothing before this line touches
  // Firestore at all.
  const auth = await requireAdmin(event, timer);
  if (!auth.ok) return fail(auth.status, auth.error);

  const db = getDb();
  const productsSnap = await timer.time('productsQueryMs', () => db.collection('products').orderBy('title').get());

  const t = timer.summary();
  return ok({
    transport: 'grpc',
    authStatusReadMs: t.authStatusReadMs,
    productsQueryMs: t.productsQueryMs,
    productDocsRead: productsSnap.size,
    _timing: t,
  });
});
