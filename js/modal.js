/**
 * BuddyModal — generic zoom-modal shell (backdrop, frame, close button).
 *
 * Phase 1 only owns open/close plumbing. The product customizer (a later
 * phase) will call `BuddyModal.open(node)` with its own composed live-preview
 * markup (the product image + placed patches + name, matching the exact
 * on-page positions) so the zoom view is never a separate rendering path.
 *
 * Public API:
 *   BuddyModal.open(contentEl)  // contentEl: DOM node or HTML string
 *   BuddyModal.close()
 */
(function () {
  let mounted = false;
  let isOpen = false;
  let els = {};

  function init() {
    if (mounted) return;
    mounted = true;

    const overlay = document.createElement('div');
    overlay.className = 'zoom-overlay';
    overlay.id = 'buddy-zoom-overlay';
    overlay.innerHTML = `
      <div class="zoom-overlay__backdrop" data-zoom-close></div>
      <div class="zoom-modal" role="dialog" aria-label="Zoomed product preview">
        <button type="button" class="zoom-modal__close" data-zoom-close aria-label="Close">&times;</button>
        <div class="zoom-modal__content" data-zoom-content></div>
      </div>
    `;
    document.body.appendChild(overlay);

    els.overlay = overlay;
    els.content = overlay.querySelector('[data-zoom-content]');

    overlay.querySelectorAll('[data-zoom-close]').forEach((el) => {
      el.addEventListener('click', close);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }

  function open(content) {
    init();
    if (typeof content === 'string') {
      els.content.innerHTML = content;
    } else if (content instanceof Node) {
      els.content.innerHTML = '';
      els.content.appendChild(content);
    }
    els.overlay.classList.add('is-open');
    if (!isOpen) {
      isOpen = true;
      window.BuddyScrollLock.lock();
    }
  }

  function close() {
    if (!mounted || !isOpen) return;
    els.overlay.classList.remove('is-open');
    isOpen = false;
    window.BuddyScrollLock.unlock();
  }

  window.BuddyModal = { open, close };
})();
