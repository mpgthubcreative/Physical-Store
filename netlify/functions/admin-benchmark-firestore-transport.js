/*
 * GET /api/admin-benchmark-firestore-transport
 *
 * TEMPORARY DIAGNOSTIC ENDPOINT — not part of the app's real surface. Exists
 * to answer, on real production infrastructure, whether Firestore's REST
 * transport (`preferRest: true`) avoids the ~1.3-1.45s "first Firestore
 * call of the invocation" cost measured on admin-list-products, before
 * changing the transport globally (which would affect every function in
 * the app, not just this one).
 *
 * Owner AND Admin, requireAdmin — deliberately the FRESH, UNCACHED path,
 * not requireAdminCached. An internal diagnostic tool gets the strictest
 * check available, not the read-optimization; it is also not part of any
 * daily workflow page, so there is nothing to optimize here.
 *
 * ---- What it measures ----
 * Four numbers, all on the SAME real adminUsers/{uid} doc and the SAME
 * `products` collection this app actually queries elsewhere, so the
 * comparison is apples-to-apples with production's real behavior:
 *
 *   grpcAuthStatusReadMs  — adminUsers/{uid} read via the DEFAULT (gRPC)
 *                           client. This IS the real, uncached first
 *                           Firestore call of this invocation — captured
 *                           via requireAdmin's own timer, not a second
 *                           artificial read, so it is not warmed by
 *                           anything that ran before it.
 *   grpcProductsQueryMs   — the products query via that SAME default
 *                           client, run second — reflects what an
 *                           already-warmed-up gRPC channel costs, the
 *                           same shape admin-list-products experiences.
 *   restAuthStatusReadMs  — the SAME adminUsers/{uid} doc, read via an
 *                           ISOLATED preferRest client's FIRST call ever
 *                           on this container — the fair comparison point
 *                           for grpcAuthStatusReadMs.
 *   restProductsQueryMs   — the products query via that REST client,
 *                           second call — the fair comparison point for
 *                           grpcProductsQueryMs.
 *
 * ---- Isolation ----
 * The REST client is a completely separate named Firebase app (see
 * _shared/firestoreRestClient.js) — nothing here can change the transport
 * used by any other function or endpoint in this app.
 *
 * ---- Privacy ----
 * Returns ONLY timings and document counts. Never the adminUsers document's
 * contents, never any product content, never a token.
 *
 * DELETE THIS FILE once the transport question is settled — it is not
 * meant to be a permanent part of the app's API surface.
 */
const { getDb } = require('./_shared/firebaseAdmin');
const { getRestDb } = require('./_shared/firestoreRestClient');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { createTimer } = require('./_shared/timing');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const timer = createTimer();

  // Fresh, uncached — see file header for why.
  const auth = await requireAdmin(event, timer);
  if (!auth.ok) return fail(auth.status, auth.error);

  // --- gRPC (default) transport: the real, already-in-progress invocation ---
  // grpcAuthStatusReadMs was ALREADY measured by requireAdmin() above as
  // 'authStatusReadMs' — reusing that instead of reading the doc a second
  // time keeps this a true "first call of the invocation" measurement.
  const defaultDb = getDb();
  const grpcProductsSnap = await timer.time('grpcProductsQueryMs', () => defaultDb.collection('products').orderBy('title').get());

  // --- REST transport: isolated client, first use on this container ---
  const restDb = getRestDb();
  const restStatusSnap = await timer.time('restAuthStatusReadMs', () => restDb.collection('adminUsers').doc(auth.uid).get());
  const restProductsSnap = await timer.time('restProductsQueryMs', () => restDb.collection('products').orderBy('title').get());

  const t = timer.summary();

  return ok({
    grpc: {
      authStatusReadMs: t.authStatusReadMs, // measured inside requireAdmin() above
      productsQueryMs: t.grpcProductsQueryMs,
      productDocsRead: grpcProductsSnap.size,
    },
    rest: {
      authStatusReadMs: t.restAuthStatusReadMs,
      productsQueryMs: t.restProductsQueryMs,
      productDocsRead: restProductsSnap.size,
      statusDocFound: restStatusSnap.exists,
    },
    // Convenience deltas — negative means REST was faster.
    delta: {
      authStatusReadMs: (t.authStatusReadMs || 0) - (t.restAuthStatusReadMs || 0),
      productsQueryMs: (t.grpcProductsQueryMs || 0) - (t.restProductsQueryMs || 0),
    },
    _timing: t,
  });
});
