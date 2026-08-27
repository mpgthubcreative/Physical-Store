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
      // Force exactly one fresh token fetch per page load. Custom claims
      // (admin/role) only take effect on a token refresh — a tab left open
      // across a claims change (promotion, role change, disable) would
      // otherwise keep sending a stale cached token that fails
      // requireAdmin() server-side even though the account is correctly
      // set up. Firebase caches this refreshed token internally, so every
      // later non-forced getIdToken() call in apiFetch reuses it — this
      // isn't a forced refresh on every request, just once per load.
      await user.getIdToken(true);
      resolve(user);
    });
  });
}

async function getClaims() {
  const user = auth.currentUser;
  if (!user) return { admin: false, role: null };
  const result = await user.getIdTokenResult();
  return { admin: result.claims.admin === true, role: result.claims.role || null };
}

async function signIn(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

async function signOutAndRedirect() {
  await firebaseSignOut(auth);
  location.href = 'login.html';
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

export { requireSession, getClaims, signIn, signOutAndRedirect, apiFetch };
window.AdminAuth = { requireSession, getClaims, signIn, signOutAndRedirect, apiFetch };
