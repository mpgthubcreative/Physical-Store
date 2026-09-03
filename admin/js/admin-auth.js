/**
 * Shared admin session guard + authenticated API fetch helper.
 *
 * Client-side auth state here is UX ONLY — every real authorization check
 * happens server-side in each Netlify Function via requireAdmin()/
 * requireOwner(). This module's job is just: don't show admin pages to a
 * signed-out browser, and attach a fresh ID token to every API call.
 */
import { auth } from './firebase-init.js';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';

// Marks that this browser session has already done its forced claims
// refresh. sessionStorage (not localStorage) so a new tab or a fresh
// sign-in refreshes again, but navigating between admin pages does not.
const CLAIMS_REFRESHED_KEY = 'buddy_admin_claims_refreshed_v1';

function claimsAlreadyRefreshed() {
  try {
    return sessionStorage.getItem(CLAIMS_REFRESHED_KEY) === '1';
  } catch (err) {
    return false; // storage unavailable — fall back to refreshing every load
  }
}

function markClaimsRefreshed() {
  try {
    sessionStorage.setItem(CLAIMS_REFRESHED_KEY, '1');
  } catch (err) {
    /* nothing to remember if storage is unavailable */
  }
}

/** Resolves with the signed-in user, or redirects to login and never resolves. */
function requireSession() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (!location.pathname.endsWith('/admin/login.html')) {
          location.href = 'login.html';
        }
        return;
      }

      // Custom claims (admin/role) only take effect on a token refresh, so
      // one FORCED refresh is needed to pick up a promotion/role change/
      // disable that happened while this browser held a cached token.
      //
      // That refresh is a network round-trip to Google's token endpoint,
      // and doing it on EVERY admin page load put ~150-400ms of blocking
      // latency in front of every single navigation — the Owner clicks
      // Orders, and nothing renders until Google answers. So it now runs
      // once per browser session instead of once per page load.
      //
      // This does not weaken the disabled-account check, because that check
      // does not depend on the token at all: adminAuth.js re-reads
      // adminUsers/{uid}.status on EVERY server request and rejects a
      // disabled account regardless of how fresh the token is. The forced
      // refresh only accelerates picking up a CLAIMS change, and it still
      // happens on the first page of each session (i.e. right after
      // sign-in, which is when claims realistically change). Firebase also
      // auto-refreshes tokens roughly hourly on its own.
      if (!claimsAlreadyRefreshed()) {
        await user.getIdToken(true);
        markClaimsRefreshed();
      }
      resolve(user);
    });
  });
}

async function getClaims() {
  const user = auth.currentUser;
  if (!user) return { admin: false, role: null, uid: null };
  const result = await user.getIdTokenResult();
  return { admin: result.claims.admin === true, role: result.claims.role || null, uid: user.uid };
}

function clearClaimsRefreshMark() {
  try {
    sessionStorage.removeItem(CLAIMS_REFRESHED_KEY);
  } catch (err) {
    /* nothing to clear if storage is unavailable */
  }
}

async function signIn(email, password) {
  // Clear the once-per-session marker so the page loaded right after
  // sign-in performs its forced claims refresh, even when this tab already
  // did one for a previously signed-in account.
  clearClaimsRefreshMark();
  return signInWithEmailAndPassword(auth, email, password);
}

async function signOutAndRedirect() {
  clearClaimsRefreshMark();
  await firebaseSignOut(auth);
  location.href = 'login.html';
}

/**
 * The current user's Firebase ID token.
 *
 * apiFetch() below covers every JSON endpoint. This is for the few cases
 * that need the raw token because they don't want JSON parsing — notably
 * the report exports, which return a binary .xlsx/.pdf body that has to be
 * read as a blob. Exposing the token accessor keeps that one case from
 * hand-rolling its own auth handling.
 */
async function getIdToken() {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');
  return user.getIdToken();
}

/** fetch() wrapper that attaches a fresh Firebase ID token and parses the JSON envelope every admin-* function returns. */
async function apiFetch(path, options = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');
  const token = await user.getIdToken();

  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export { requireSession, getClaims, getIdToken, signIn, signOutAndRedirect, apiFetch };
window.AdminAuth = { requireSession, getClaims, getIdToken, signIn, signOutAndRedirect, apiFetch };
