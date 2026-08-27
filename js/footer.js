/**
 * BuddyFooter — shared footer (optional newsletter block + logo + copyright).
 *
 * Usage: BuddyFooter.init('#site-footer', { showNewsletter: true })
 */
(function () {
  function init(selector, opts) {
    const opt = opts || {};
    const showNewsletter = !!opt.showNewsletter;
    const mount = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!mount) throw new Error('BuddyFooter.init: mount point "' + selector + '" not found.');

    mount.innerHTML = `
      <footer class="site-footer">
        <div class="site-footer__inner">
          ${
            showNewsletter
              ? `
          <div class="site-footer__newsletter">
            <h3>Subscribe to our emails</h3>
            <p>Little updates, new patches, and event dates &mdash; no spam.</p>
            <form data-newsletter-form>
              <div class="site-footer__form">
                <input type="email" required placeholder="Email" aria-label="Email address" />
                <button type="submit" aria-label="Subscribe">&rarr;</button>
              </div>
              <p class="site-footer__note" data-newsletter-note></p>
            </form>
          </div>`
              : ''
          }
          <div class="site-footer__bottom${showNewsletter ? ' site-footer__bottom--ruled' : ''}">
            <img src="./assets/buddy-logo.jpg" alt="Buddy Patches" />
            <div class="site-footer__copyright">&copy; 2026, Buddy Patches. All Right Reserved.</div>
          </div>
        </div>
      </footer>
    `;

    const form = mount.querySelector('[data-newsletter-form]');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        // No backend yet (Phase 1) — placeholder confirmation only.
        const note = form.querySelector('[data-newsletter-note]');
        note.textContent = "Thanks — you're on the list!";
        form.reset();
      });
    }
  }

  window.BuddyFooter = { init };
})();
