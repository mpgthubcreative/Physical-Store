import { getClaims, signOutAndRedirect } from './admin-auth.js';
import { auth } from './firebase-init.js';

const NAV_LINKS = [
  { key: 'dashboard', label: 'Dashboard', href: 'index.html' },
  { key: 'orders', label: 'Orders', href: 'orders.html' },
  { key: 'products', label: 'Products', href: 'products.html' },
  { key: 'patches', label: 'Patches', href: 'patches.html' },
  { key: 'collections', label: 'Collections', href: 'collections.html' },
];

export async function renderAdminShell(activeKey) {
  const claims = await getClaims();
  const mount = document.getElementById('admin-topbar');
  const email = auth.currentUser ? auth.currentUser.email : '';

  // The Team nav link is never inserted into the DOM at all for a non-Owner
  // — this is UX only, not the real enforcement. Every Team API independently
  // calls requireOwner() server-side regardless of what the client sends.
  const navLinks = claims.role === 'owner' ? [...NAV_LINKS, { key: 'team', label: 'Team', href: 'team.html' }] : NAV_LINKS;

  mount.innerHTML = `
    <div class="admin-topbar">
      <div class="admin-topbar__brand">
        <img src="../assets/buddy-logo.jpg" alt="Buddy Patches" />
        Admin
      </div>
      <nav class="admin-topbar__nav">
        ${navLinks.map((l) => `<a href="${l.href}" class="${l.key === activeKey ? 'is-active' : ''}">${l.label}</a>`).join('')}
      </nav>
      <div class="admin-topbar__user">
        <span>${email} &middot; ${claims.role === 'owner' ? 'Owner' : 'Admin'}</span>
        <button type="button" data-sign-out>Sign out</button>
      </div>
    </div>
  `;

  mount.querySelector('[data-sign-out]').addEventListener('click', () => signOutAndRedirect());

  return claims;
}
