/**
 * BuddyScrollLock — shared body-scroll lock for any full-screen overlay
 * (cart drawer, zoom modal, ...). Reference-counted so two overlays can be
 * open at once (e.g. tab to the cart while the zoom modal is open) without
 * one's close prematurely unlocking scroll for the other. Defined here
 * because cart.js is the first script every page loads.
 */
(function () {
  let locks = 0;
  function lock() {
    locks += 1;
    document.body.style.overflow = 'hidden';
  }
  function unlock() {
    locks = Math.max(0, locks - 1);
    if (locks === 0) document.body.style.overflow = '';
  }
  window.BuddyScrollLock = { lock, unlock };
})();

/**
 * BuddyCart — single shared source of truth for cart state + the cart drawer UI.
 *
 * Every unique customization is its own line: callers (the product
 * customizer) are responsible for computing a stable `key` per line (e.g. a
 * hash of variant + placed patches + name text) so identical SKUs with
 * different configurations never merge. This module never assumes SKU alone
 * is unique.
 *
 * Persisted to localStorage (guest cart, frontend-only) so it survives
 * navigating between pages — the state a real shopper actually needs.
 * Server-authoritative price/stock re-validation still happens at checkout,
 * later, once a backend exists; this is display-only persistence.
 *
 * Public API (stable — later phases plug into this, it should not need to
 * change shape):
 *   BuddyCart.addItem({ key, name, subtitle, unitPrice, qty, thumbColor })
 *   BuddyCart.removeItem(key)
 *   BuddyCart.setQty(key, qty)
 *   BuddyCart.getItems() -> array (copy)
 *   BuddyCart.getCount() -> number
 *   BuddyCart.getSubtotal() -> number
 *   BuddyCart.subscribe(fn) -> unsubscribe()
 *   BuddyCart.format(n) -> "₱1,234.00"
 *   BuddyCart.initDrawer() -> mounts the drawer DOM once
 *   BuddyCart.open() / BuddyCart.close()
 */
(function () {
  const STORAGE_KEY = 'buddy_cart_v1';

  function loadItems() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return []; // private-browsing / storage disabled — fall back to a session-only cart
    }
  }
  function saveItems() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (err) {
      /* storage unavailable — cart still works for this page load */
    }
  }

  let items = loadItems();
  const listeners = new Set();

  function notify() {
    saveItems();
    listeners.forEach((fn) => fn(getItems()));
    renderDrawer();
  }

  function getItems() {
    return items.map((i) => ({ ...i }));
  }

  function getCount() {
    return items.reduce((sum, i) => sum + i.qty, 0);
  }

  function getSubtotal() {
    return items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
  }

  function format(n) {
    return '₱' + Number(n || 0).toLocaleString('en-PH') + '.00';
  }

  function addItem(item) {
    if (!item || !item.key) {
      throw new Error('BuddyCart.addItem requires a stable "key" per unique configuration.');
    }
    const existing = items.find((i) => i.key === item.key);
    if (existing) {
      existing.qty += item.qty || 1;
    } else {
      items.push({ qty: 1, ...item });
    }
    notify();
  }

  function removeItem(key) {
    items = items.filter((i) => i.key !== key);
    notify();
  }

  function setQty(key, qty) {
    const line = items.find((i) => i.key === key);
    if (!line) return;
    line.qty = Math.max(1, qty | 0);
    notify();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // ---- drawer DOM ----
  let mounted = false;
  let isOpen = false;
  let els = {};

  function initDrawer() {
    if (mounted) return;
    mounted = true;

    const overlay = document.createElement('div');
    overlay.className = 'cart-overlay';
    overlay.id = 'buddy-cart-overlay';
    overlay.innerHTML = `
      <div class="cart-overlay__backdrop" data-cart-close></div>
      <div class="cart-drawer" role="dialog" aria-label="Your cart">
        <div class="cart-drawer__head">
          <h2>Your cart</h2>
          <button type="button" class="cart-drawer__close" data-cart-close aria-label="Close cart">&times;</button>
        </div>
        <div class="cart-drawer__body" data-cart-body></div>
        <div class="cart-drawer__foot">
          <div class="cart-drawer__subtotal">
            <span>Subtotal</span>
            <span data-cart-subtotal>${format(0)}</span>
          </div>
          <button type="button" class="btn-coral" data-cart-checkout disabled>Check out</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    els.overlay = overlay;
    els.body = overlay.querySelector('[data-cart-body]');
    els.subtotal = overlay.querySelector('[data-cart-subtotal]');
    els.checkout = overlay.querySelector('[data-cart-checkout]');

    overlay.querySelectorAll('[data-cart-close]').forEach((el) => {
      el.addEventListener('click', close);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    renderDrawer();
  }

  function renderDrawer() {
    if (!mounted) return;
    if (items.length === 0) {
      els.body.innerHTML = '<div class="cart-drawer__empty">Your cart is empty.<br>Design a pouch to get started!</div>';
    } else {
      els.body.innerHTML = items
        .map(
          (i) => `
        <div class="cart-line" data-key="${i.key}">
          <div class="cart-line__thumb" style="${i.thumbColor ? `background:${i.thumbColor};` : ''}"></div>
          <div class="cart-line__info">
            <div class="cart-line__name">${i.name}</div>
            <div class="cart-line__sub">${i.subtitle || ''} &middot; &times;${i.qty}</div>
            <button type="button" class="cart-line__remove" data-remove="${i.key}">Remove</button>
          </div>
          <div class="cart-line__price">${format(i.unitPrice * i.qty)}</div>
        </div>`
        )
        .join('');
      els.body.querySelectorAll('[data-remove]').forEach((btn) => {
        btn.addEventListener('click', () => removeItem(btn.getAttribute('data-remove')));
      });
    }
    els.subtotal.textContent = format(getSubtotal());
    els.checkout.disabled = items.length === 0;
  }

  function open() {
    initDrawer();
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

  window.BuddyCart = {
    addItem,
    removeItem,
    setQty,
    getItems,
    getCount,
    getSubtotal,
    format,
    subscribe,
    initDrawer,
    open,
    close,
  };
})();
