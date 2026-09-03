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
const { TTLCache } = require('./ttlCache');

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

/*
 * ============================================================================
 * SHORT-LIVED ADMIN-STATUS CACHE — READ-ONLY ENDPOINTS ONLY
 * ============================================================================
 *
 * Production measurement (Phase 5D.3): the adminUsers/{uid} status read
 * alone cost ~1.3-1.45s per invocation — ~80% of admin-list-products'
 * total handler time — even on a warm Lambda instance reusing the same
 * cached Firestore client (confirmed via firebase-admin's ensureService_,
 * which memoizes the Firestore service per app; no client/channel is being
 * reconstructed per request). The SECOND Firestore call in the same
 * invocation (the actual products query) cost only ~340-366ms, so the cost
 * is specifically "first Firestore call of this invocation," which matches
 * AWS Lambda's documented freeze/thaw behavior: even a warm container's
 * network connections are not guaranteed to survive a freeze, so the first
 * call after thaw can pay a fresh connection/channel-establishment cost
 * regardless of how long the container's JS state has been alive.
 *
 * requireAdminCached() below trades a few seconds of staleness on that ONE
 * specific read for cutting the per-request Firestore round trip most of
 * the time. It is a SEPARATE function from requireAdmin()/requireOwner()
 * above — neither of those is modified, and neither is used by anything
 * that calls requireAdminCached() instead.
 *
 * ---- What is cached ----
 * ONLY the boolean "is this adminUsers/{uid} doc's status 'disabled'?" —
 * nothing else. Never a token. Never a role, email, or any profile data.
 * Keyed by uid, TTL 20 seconds (within the approved 15-30s range), living
 * only in this Lambda instance's process Map (see _shared/ttlCache.js) —
 * never written to Firestore, never persisted anywhere, gone the moment the
 * container is recycled, and never shared across instances.
 *
 * ---- What is NEVER cached ----
 * verifyIdToken() still runs on EVERY single call, cache hit or miss. A
 * revoked, expired, or tampered token is rejected immediately regardless of
 * this cache. This cache only ever affects how quickly a *disable* action
 * (an Owner disabling a team member) takes effect for READ endpoints — it
 * can never let an invalid session through.
 *
 * ---- The actual security boundary ----
 * This function must be called ONLY by endpoints that read data and change
 * nothing: order/report/settings/team LISTS and single-record READS. Every
 * mutation and every sensitive action — payment approval/rejection,
 * fulfillment changes, product/patch/collection saves and destructive
 * actions, image upload/removal, payment or shipping settings writes,
 * checkout activation, and all Team create/disable/reactivate/remove
 * actions — MUST keep calling requireAdmin()/requireOwner() (uncached,
 * unchanged above), so a disabled account is refused those actions
 * IMMEDIATELY, every time, with no cache window at all.
 * scripts/test-auth-cache-boundary.js asserts this boundary from the actual
 * source of every admin-* function, not just from this comment.
 *
 * Worst case if a disabled account still holds a live ID token: for up to
 * ADMIN_STATUS_CACHE_TTL_MS after being disabled, it can keep VIEWING
 * lists/dashboards/settings it could already see — it can never approve a
 * payment, touch inventory, change fulfillment, save/delete anything, or
 * modify Team/settings, because none of those endpoints call this function.
 */
const ADMIN_STATUS_CACHE_TTL_MS = 20 * 1000; // 20s — within the approved 15-30s range
const adminStatusCache = new TTLCache();

/**
 * Same authorization contract as requireAdmin() — returns
 * { ok, uid, email, role, cacheHit } or { ok: false, status, error } — with
 * the adminUsers/{uid} status read served from the short-lived cache above
 * when available. `cacheHit` tells the caller whether this request paid for
 * a fresh Firestore read or not, for the _timing diagnostics.
 *
 * READ-ONLY ENDPOINTS ONLY — see the boundary explanation above.
 */
async function requireAdminCached(event, timer) {
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

    const cached = adminStatusCache.get(decoded.uid);
    let disabled;
    let cacheHit;

    if (cached !== undefined) {
        disabled = cached;
        cacheHit = true;
        if (timer) timer.record('authStatusReadMs', 0);
    } else {
        cacheHit = false;
        disabled = false;
        try {
            const readStatus = () => getDb().collection('adminUsers').doc(decoded.uid).get();
            const snap = timer ? await timer.time('authStatusReadMs', readStatus) : await readStatus();
            disabled = snap.exists && snap.data().status === 'disabled';
            adminStatusCache.set(decoded.uid, disabled, ADMIN_STATUS_CACHE_TTL_MS);
        } catch (err) {
            // Firestore hiccup — fail open on the read itself, same as
            // requireAdmin(). Deliberately NOT cached: a transient failure
            // must not freeze a false "not disabled" answer for 20s.
        }
    }

    if (disabled) {
        return { ok: false, status: 403, error: 'This account has been disabled. Contact your Owner.' };
    }

    const role = decoded.role === 'owner' ? 'owner' : 'admin';
    return { ok: true, uid: decoded.uid, email: decoded.email || null, role, cacheHit };
}

/**
 * Cached counterpart to requireOwner() — same relationship requireOwner()
 * already has to requireAdmin(): verifies via the cached path above, then
 * additionally requires role === 'owner'. Used only by Owner-only READ
 * endpoints (currently: Team list). The role itself is never cached
 * separately — it comes from the same verified ID token requireAdminCached()
 * just checked, every call, cache hit or not.
 */
async function requireOwnerCached(event, timer) {
    const result = await requireAdminCached(event, timer);
    if (!result.ok) return result;
    if (result.role !== 'owner') {
        return { ok: false, status: 403, error: 'This action is restricted to the Owner account.' };
    }
    return result;
}

/** Test-only: clears the in-memory admin-status cache between test cases. Never called from production code. */
function _clearAdminStatusCacheForTests() {
    adminStatusCache.clear();
}

module.exports = {
    requireAdmin,
    requireOwner,
    requireAdminCached,
    requireOwnerCached,
    ADMIN_STATUS_CACHE_TTL_MS,
    _clearAdminStatusCacheForTests,
    // Exported for admin-benchmark-firestore-rest.js, which must verify the
    // token WITHOUT touching the default (gRPC) Firestore client at all —
    // reusing requireAdmin() there would make a gRPC call before the
    // REST-only measurement even starts. Everything else about token
    // extraction is identical to the checks above; this just avoids a
    // second, drifting implementation of the same three lines.
    extractBearerToken,
};
