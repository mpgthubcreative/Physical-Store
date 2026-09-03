/*
 * Shared admin authorization for Netlify Functions.
 *
 * Every admin-* function must call requireAdmin(event) (or requireOwner(event)
 * for Owner-only actions) FIRST, before touching Firestore/Storage. Both
 * verify the Firebase ID token in the Authorization header and check the
 * admin:true custom claim — frontend checks are UX only, this is the real
 * enforcement.
 *
 * Role model: every admin account (Owner or Admin) carries admin:true, plus
 * a role:'owner'|'admin' custom claim. Owner is permanent/full-access
 * (Team management, permanent delete); Admin can manage catalog/orders but
 * not Team or destructive/owner-only actions — enforced per-function by
 * choosing requireAdmin() vs requireOwner(), not by anything the client
 * sends.
 *
 * Disabling a team member does two things: Firebase Auth disabled:true +
 * revokeRefreshTokens (blocks all *future* sign-ins/token refreshes
 * immediately), AND flips adminUsers/{uid}.status to 'disabled'. The second
 * part matters because a Firebase ID token that's already been issued keeps
 * verifying successfully for up to its ~1 hour lifetime regardless of the
 * disabled flag unless verification itself checks token revocation — which
 * costs an extra live call to the Auth backend on every request. Checking
 * our own adminUsers/{uid}.status via a single Firestore point-read by
 * primary key is the cheaper alternative used here instead.
 */
const { getAdminAuth, getDb } = require('./firebaseAdmin');

function extractBearerToken(event) {
    const header = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const match = header.match(/^Bearer (.+)$/);
    return match ? match[1] : null;
}

/**
 * Core verification shared by requireAdmin/requireOwner. Returns
 * { ok: true, uid, email, role } or { ok: false, status, error }.
 *
 * `timer` is optional (see _shared/timing.js). When supplied, the two
 * distinct costs here are measured SEPARATELY, because they are very
 * different things and only one of them is a Firestore query:
 *
 *   authVerifyTokenMs  — verifyIdToken(). On the first call in a Lambda
 *                        instance this also fetches Google's public signing
 *                        keys over the network; afterwards it is local
 *                        signature verification against a cached key set.
 *   authStatusReadMs   — the adminUsers/{uid} point read. This is the first
 *                        Firestore call in most handlers, so it also pays
 *                        the one-time gRPC client construction and channel
 *                        setup for the whole instance.
 *
 * Only durations are recorded — never the token, uid, or email.
 */
async function verifyAdminToken(event, timer) {
    const token = extractBearerToken(event);
    if (!token) {
        return { ok: false, status: 401, error: 'Missing authorization.' };
    }

    let decoded;
    try {
        decoded = timer
            ? await timer.time('authVerifyTokenMs', () => getAdminAuth().verifyIdToken(token))
            : await getAdminAuth().verifyIdToken(token);
    } catch (err) {
        return { ok: false, status: 401, error: 'Invalid or expired session. Please sign in again.' };
    }

    if (decoded.admin !== true) {
        return { ok: false, status: 403, error: 'You are not authorized to perform this action.' };
    }

    // Fail-open if no adminUsers doc exists yet — absence of the doc is not
    // itself a reason to lock someone out; only an explicit status:
    // 'disabled' blocks access. This check stays: it is what actually
    // enforces a disabled Admin, independently of token freshness.
    let disabled = false;
    try {
        const readStatus = () => getDb().collection('adminUsers').doc(decoded.uid).get();
        const snap = timer ? await timer.time('authStatusReadMs', readStatus) : await readStatus();
        if (snap.exists && snap.data().status === 'disabled') {
            disabled = true;
        }
    } catch (err) {
        // Firestore hiccup on the status check — fail open on the read
        // itself (same reasoning as a missing doc); the admin:true claim
        // check above already happened and stands.
    }

    if (disabled) {
        return { ok: false, status: 403, error: 'This account has been disabled. Contact your Owner.' };
    }

    const role = decoded.role === 'owner' ? 'owner' : 'admin';
    return { ok: true, uid: decoded.uid, email: decoded.email || null, role };
}

/**
 * Returns { ok: true, uid, email, role } or { ok: false, status, error }.
 * Use for every action both Owner and Admin may perform.
 */
async function requireAdmin(event, timer) {
    return verifyAdminToken(event, timer);
}

/**
 * Returns { ok: true, uid, email, role: 'owner' } or { ok: false, status, error }.
 * Use for Owner-only actions (Team management, permanent delete). Never
 * trust a role value from the request itself — this only ever reads the
 * role out of the verified ID token's custom claims.
 */
async function requireOwner(event, timer) {
    const result = await verifyAdminToken(event, timer);
    if (!result.ok) return result;
    if (result.role !== 'owner') {
        return { ok: false, status: 403, error: 'This action is restricted to the Owner account.' };
    }
    return result;
}

module.exports = { requireAdmin, requireOwner };
