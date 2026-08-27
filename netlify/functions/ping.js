/*
 * Infrastructure smoke test — NOT part of any ecommerce flow.
 *
 * Confirms this Netlify deploy has FIREBASE_SERVICE_ACCOUNT_JSON /
 * FIREBASE_STORAGE_BUCKET set correctly and that the Admin SDK can reach
 * this Buddy project's Firestore. Safe to call from a browser: it never
 * reads or writes any real data, and it requires no admin token.
 *
 * Call it at /api/ping once Netlify env vars are configured, to verify the
 * Phase 5A wiring before anything else is built on top of it.
 */
const { getDb } = require('./_shared/firebaseAdmin');

exports.handler = async function () {
    try {
        const db = getDb();
        // Cheapest possible real round-trip: read a doc that almost
        // certainly doesn't exist yet. A clean response (found or not)
        // proves the credentials + project wiring are correct; only a
        // thrown error means something is actually misconfigured.
        await db.collection('_health').doc('ping').get();

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            body: JSON.stringify({ ok: true, project: process.env.FIREBASE_STORAGE_BUCKET || null }),
        };
    } catch (err) {
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            body: JSON.stringify({ ok: false, error: err.message }),
        };
    }
};
