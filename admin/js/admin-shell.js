import { getClaims, signOutAndRedirect } from './admin-auth.js';
import { auth } from './firebase-init.js';

const ICONS = {
  dashboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  orders: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2 5 6v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6l-1-4"/><path d="M5 6h14M9 10a3 3 0 0 0 6 0"/></svg>',
  products: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/></svg>',
  patches: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 4 6v6c0 5 3.4 8.7 8 10 4.6-1.3 8-5 8-10V6l-8-4Z"/></svg>',
  collections: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></svg>',
  team: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="18" cy="8.5" r="2.6"/><path d="M16 14.5a5.2 5.2 0 0 1 5.5 5.2"/></svg>',
  settings: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>',
};

const NAV_LINKS = [
  { key: 'dashboard', label: 'Dashboard', href: 'index.html', icon: ICONS.dashboard },
  { key: 'orders', label: 'Orders', href: 'orders.html', icon: ICONS.orders },
  { key: 'products', label: 'Products', href: 'products.html', icon: ICONS.products },
  { key: 'patches', label: 'Patches', href: 'patches.html', icon: ICONS.patches },
  { key: 'collections', label: 'Collections', href: 'collections.html', icon: ICONS.collections },
];

// Settings sits below the catalog links, above Team — both Owner and Admin
// can open it (an Admin manages shipping rates there), but the Payments tab
// disables its own controls for a non-Owner and every save is
// independently re-authorized server-side.
const SETTINGS_LINK = { key: 'settings', label: 'Settings', href: 'settings.html', icon: ICONS.settings };

function initials(email) {
  if (!email) return '?';
  const name = email.split('@')[0];
  const parts = name.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export async function renderAdminShell(activeKey) {
  const claims = await getClaims();
  const email = auth.currentUser ? auth.currentUser.email : '';
  const roleLabel = claims.role === 'owner' ? 'Owner' : 'Admin';

  // The Team nav link is never inserted into the DOM at all for a non-Owner
  // — this is UX only, not the real enforcement. Every Team API independently
  // calls requireOwner() server-side regardless of what the client sends.
  const navLinks =
    claims.role === 'owner'
      ? [...NAV_LINKS, SETTINGS_LINK, { key: 'team', label: 'Team', href: 'team.html', icon: ICONS.team }]
      : [...NAV_LINKS, SETTINGS_LINK];
  const active = navLinks.find((l) => l.key === activeKey);

  const sidebarMount = document.getElementById('admin-sidebar');
  const topbarMount = document.getElementById('admin-topbar');

  sidebarMount.innerHTML = `
    <aside class="admin-sidebar" data-admin-sidebar>
      <div class="admin-sidebar__brand">
        <img src="../assets/buddy-logo.jpg" alt="" width="30" height="30" decoding="async" />
        <span>Buddy Admin</span>
      </div>
      <nav class="admin-sidebar__nav">
        ${navLinks
          .map(
            (l) => `<a href="${l.href}" class="admin-nav-link${l.key === activeKey ? ' is-active' : ''}">
              <span class="admin-nav-link__icon">${l.icon}</span>${l.label}
            </a>`
          )
          .join('')}
      </nav>
      <div class="admin-sidebar__footer">
        <div class="admin-account">
          <div class="admin-account__avatar">${initials(email)}</div>
          <div class="admin-account__body">
            <div class="admin-account__email" title="${email}">${email}</div>
            <div class="admin-account__role">${roleLabel}</div>
          </div>
        </div>
        <button type="button" class="admin-signout-btn" data-sign-out>Sign out</button>
      </div>
    </aside>
  `;

  const scrim = document.createElement('div');
  scrim.className = 'admin-scrim';
  scrim.setAttribute('data-admin-scrim', '');
  document.body.appendChild(scrim);

  topbarMount.innerHTML = `
    <div class="admin-mobile-topbar">
      <button type="button" class="admin-menu-btn" data-menu-toggle aria-label="Open menu">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
      </button>
      <div class="admin-mobile-topbar__title">${active ? active.label : ''}</div>
    </div>
  `;

  const sidebarEl = sidebarMount.querySelector('[data-admin-sidebar]');
  const openMenu = () => {
    sidebarEl.classList.add('is-open');
    scrim.classList.add('is-open');
  };
  const closeMenu = () => {
    sidebarEl.classList.remove('is-open');
    scrim.classList.remove('is-open');
  };
  topbarMount.querySelector('[data-menu-toggle]').addEventListener('click', openMenu);
  scrim.addEventListener('click', closeMenu);
  sidebarEl.querySelectorAll('.admin-nav-link').forEach((a) => a.addEventListener('click', closeMenu));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  sidebarMount.querySelector('[data-sign-out]').addEventListener('click', () => signOutAndRedirect());

  return claims;
}
