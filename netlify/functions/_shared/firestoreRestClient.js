/*
 * An ISOLATED, secondary Firestore client configured with `preferRest: true`
 * — used ONLY by admin-benchmark-firestore-transport.js to measure REST vs
 * the default gRPC transport on real production infrastructure, without
 * touching the shared getDb() every other function uses.
 *
 * ---- Why a completely separate named app, not db.settings() on the shared one ----
 * @google-cloud/firestore's `settings({preferRest: true})` is called ONCE on
 * a given Firestore instance and applies to every future call through it.
 * Calling that on the DEFAULT app's shared Firestore client (the one
 * _shared/firebaseAdmin.js's getDb() returns) would change the transport for
 * every other function sharing this warm container for the rest of its
 * life — a global behavior change smuggled in through a "diagnostic-only"
 * code path. Instead this creates a SECOND, independently-named Firebase
 * app (admin.initializeApp(..., 'restTransportBenchmark')), which owns its
 * own completely separate Firestore client. Nothing here can ever affect
 * getDb() or any other endpoint, no matter how this benchmark is used.
 *
 * ---- Why this is safe to leave deployed ----
 * This client is only ever constructed by the one diagnostic endpoint that
 * imports this module, which is itself gated behind requireAdmin (fresh,
 * uncached — an internal diagnostic tool deserves the strictest check, not
 * the read-cache). It performs no writes and returns no product/customer
 * content — see admin-benchmark-firestore-transport.js.
 *
 * ---- No realtime listeners in this codebase ----
 * `preferRest` uses HTTP/1.1 REST for everything except onSnapshot()
 * listeners, which are not used anywhere in this server-side codebase
 * (confirmed: `grep -rn onSnapshot netlify/` finds nothing) — so this
 * setting has no functional downside to evaluate, only a latency one.
 */
const { admin } = require('./firebaseAdmin');

const REST_APP_NAME = 'restTransportBenchmark';

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set.');
  return JSON.parse(raw);
}

/**
 * Returns the isolated REST-transport Firestore instance, creating it (and
 * its own named Firebase app) at most once per container — same
 * check-apps-first pattern _shared/firebaseAdmin.js already uses for the
 * default app, so a warm invocation reuses this instance too rather than
 * reconstructing it every call.
 */
function getRestDb() {
  let app = admin.apps.find((a) => a && a.name === REST_APP_NAME);
  if (!app) {
    app = admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) }, REST_APP_NAME);
    app.firestore().settings({ preferRest: true });
  }
  return app.firestore();
}

module.exports = { getRestDb, REST_APP_NAME };
