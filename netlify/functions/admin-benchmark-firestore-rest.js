/*
 * GET /api/admin-benchmark-firestore-rest
 *
 * TEMPORARY DIAGNOSTIC ENDPOINT — the other half of the fair transport
 * comparison. See admin-benchmark-firestore-grpc.js for the full
 * explanation of why these two exist and what they replace.
 *
 * This endpoint touches ONLY the isolated preferRest client (see
 * _shared/firestoreRestClient.js) — never the default gRPC client — so a
 * genuinely cold invocation of THIS endpoint measures REST's real
 * first-call cost with no contamination from a gRPC call earlier in the
 * same process.
 *
 * ---- Why this can't just call requireAdmin() ----
 * requireAdmin() authorizes via the DEFAULT (gRPC) client. Calling it here
 * would make a gRPC Firestore call before the REST measurement even
 * started — reintroducing exactly the ordering bias these two endpoints
 * exist to eliminate. So this file performs the SAME authorization logic
 * requireAdmin() does (verify the token, check the admin:true claim, deny
 * if adminUsers/{uid}.status === 'disabled', fail open on a read error) but
 * routes its one Firestore call through the isolated REST client instead.
 * Token verification itself never touches Firestore (it's Firebase Auth's
 * separate identity-toolkit service), so it is identical, and identically
 * timed, in both this file and its gRPC counterpart — it cannot bias the
 * comparison.
 *
 * Same shape as production: auth status read first (REST, this endpoint's
 * only first call), products query second.
 *
 * Owner AND Admin. Privacy: only timings and a document count — never
 * document contents or a token.
 *
 * DELETE THIS FILE once the transport question is settled.
 */
const { getAdminAuth } = require('./_shared/firebaseAdmin');
const { getRestDb } = require('./_shared/firestoreRestClient');
const { extractBearerToken } = require('./_shared/adminAuth');
const { withErrorHandling, ok, fail } = require('./_shared/response');
const { createTimer } = require('./_shared/timing');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const timer = createTimer();

  const token = extractBearerToken(event);
  if (!token) return fail(401, 'Missing authorization.');

  let decoded;
  try {
    // Firebase Auth token verification — a separate Google service, not
    // Firestore, and not affected by preferRest. Timed identically to the
    // gRPC counterpart's requireAdmin() call, so it cannot bias the
    // comparison either way.
    decoded = await timer.time('authVerifyTokenMs', () => getAdminAuth().verifyIdToken(token));
  } catch (err) {
    return fail(401, 'Invalid or expired session. Please sign in again.');
  }
  if (decoded.admin !== true) return fail(403, 'You are not authorized to perform this action.');

  const restDb = getRestDb();

  // FIRST Firestore call of this invocation — and the ONLY transport this
  // whole invocation ever touches.
  let disabled = false;
  try {
    const statusSnap = await timer.time('authStatusReadMs', () => restDb.collection('adminUsers').doc(decoded.uid).get());
    disabled = statusSnap.exists && statusSnap.data().status === 'disabled';
  } catch (err) {
    // Fail open on the read itself, matching requireAdmin()'s behavior.
  }
  if (disabled) return fail(403, 'This account has been disabled. Contact your Owner.');

  const productsSnap = await timer.time('productsQueryMs', () => restDb.collection('products').orderBy('title').get());

  const t = timer.summary();
  return ok({
    transport: 'rest',
    authStatusReadMs: t.authStatusReadMs,
    productsQueryMs: t.productsQueryMs,
    productDocsRead: productsSnap.size,
    _timing: t,
  });
});
