/**
 * BuddyNav — shared responsive navigation (promo bar + nav row + mobile menu).
 * One markup structure adapts via CSS between mobile and desktop — no
 * separate mobile/desktop templates.
 *
 * Usage: BuddyNav.init('#site-nav', { active: 'home' | 'shop' | 'events' | 'about' | 'contact' })
 */
(function () {
  const NAV_LINKS = [
    { key: 'home', label: 'Home', href: 'index.html' },
    { key: 'shop', label: 'Shop', href: 'catalog.html' },
    { key: 'events', label: 'Events', href: 'events.html' },
    { key: 'about', label: 'About', href: 'about.html' },
    { key: 'contact', label: 'Contact', href: 'contact.html' },
  ];

  const ICON_SEARCH =
    '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg>';
  const ICON_BAG =
    '<svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l-1 12.5H7z"></path><path d="M9 8.5V6a3 3 0 0 1 6 0v2.5"></path></svg>';

  function linksHtml(active, extraClass) {
    return NAV_LINKS.map(
      (l) =>
        `<a href="${l.href}" class="site-nav__link${extraClass ? ' ' + extraClass : ''}${l.key === active ? ' is-active' : ''}" data-nav-key="${l.key}">${l.label}</a>`
    ).join('');
  }

  function init(selector, opts) {
    const opt = opts || {};
    const active = opt.active || '';
    const mount = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!mount) throw new Error('BuddyNav.init: mount point "' + selector + '" not found.');

    mount.innerHTML = `
      <div class="site-promo">&#10022; Free nationwide shipping on orders over &#8369;1,500 &mdash; design yours today! &#10022;</div>
      <nav class="site-nav">
        <div class="site-nav__row">
          <button type="button" class="site-nav__hamburger" data-nav-hamburger aria-label="Open menu" aria-expanded="false">
            <span></span><span></span><span></span>
          </button>
          <a href="index.html" class="site-nav__logo">
            <img src="./assets/buddy-logo.jpg" alt="Buddy Patches" />
          </a>
          <div class="site-nav__links">
            ${linksHtml(active)}
          </div>
          <div class="site-nav__actions">
            <button type="button" class="site-nav__icon-btn" data-nav-search aria-label="Search">${ICON_SEARCH}</button>
            <a href="admin/" class="site-nav__login">Log in</a>
            <button type="button" class="site-nav__cart" data-nav-cart aria-label="Open cart">
              ${ICON_BAG}
              <span class="site-nav__cart-badge" data-nav-cart-badge hidden>0</span>
            </button>
          </div>
        </div>
        <div class="site-nav__mobile-menu" data-nav-mobile-menu>
          ${linksHtml(active)}
        </div>
      </nav>
    `;

    const hamburger = mount.querySelector('[data-nav-hamburger]');
    const mobileMenu = mount.querySelector('[data-nav-mobile-menu]');
    hamburger.addEventListener('click', () => {
      const open = mobileMenu.classList.toggle('is-open');
      hamburger.setAttribute('aria-expanded', String(open));
    });
    mobileMenu.querySelectorAll('.site-nav__link').forEach((a) => {
      a.addEventListener('click', () => {
        mobileMenu.classList.remove('is-open');
        hamburger.setAttribute('aria-expanded', 'false');
      });
    });

    mount.querySelectorAll('[data-nav-cart]').forEach((btn) => {
      btn.addEventListener('click', () => window.BuddyCart && window.BuddyCart.open());
    });

    // search is a Phase-1 shell affordance only — wired up once the catalog
    // search experience is built.
    mount.querySelectorAll('[data-nav-search]').forEach((btn) => {
      btn.addEventListener('click', () => {
        console.info('[BuddyNav] search is not implemented yet.');
      });
    });

    const badge = mount.querySelector('[data-nav-cart-badge]');
    function updateBadge() {
      if (!window.BuddyCart) return;
      const count = window.BuddyCart.getCount();
      badge.textContent = String(count);
      badge.hidden = count === 0;
    }
    updateBadge();
    if (window.BuddyCart) window.BuddyCart.subscribe(updateBadge);
  }

  window.BuddyNav = { init };
})();
