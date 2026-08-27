import { getClaims, signOutAndRedirect } from './admin-auth.js';
import { auth } from './firebase-init.js';

const NAV_LINKS = [
  { key: 'dashboard', label: 'Dashboard', href: 'index.html' },
  { key: 'products', label: 'Products', href: 'products.html' },
  { key: 'patches', label: 'Patches', href: 'patches.html' },
  { key: 'collections', label: 'Collections', href: 'collections.html' },
];

export async function renderAdminShell(activeKey) {
  const claims = await getClaims();
  const mount = document.getElementById('admin-topbar');
  const email = auth.currentUser ? auth.currentUser.email : '';

  mount.innerHTML = `
    <div class="admin-topbar">
      <div class="admin-topbar__brand">
        <img src="../assets/buddy-logo.jpg" alt="Buddy Patches" />
        Admin
      </div>
      <nav class="admin-topbar__nav">
        ${NAV_LINKS.map((l) => `<a href="${l.href}" class="${l.key === activeKey ? 'is-active' : ''}">${l.label}</a>`).join('')}
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
