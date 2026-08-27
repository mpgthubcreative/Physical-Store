/**
 * Checkout page: builds the create-order request from BuddyCart's items,
 * re-using the SAME idempotencyKey + orderAccessToken across retries of one
 * checkout attempt (double-click, network retry, or a page refresh before
 * success) — both are generated here, client-side, and persisted in
 * sessionStorage keyed to this attempt, never regenerated until an order
 * actually succeeds or the customer starts over.
 *
 * The cart is only ever cleared AFTER create-order returns success —
 * never optimistically — so a failed/timed-out submission leaves it intact.
 */
(function () {
  const IDENTITY_KEY = 'buddy_checkout_identity_v1';

  function randomHexToken(byteLength) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function loadOrCreateIdentity() {
    try {
      const raw = sessionStorage.getItem(IDENTITY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.idempotencyKey && parsed.orderAccessToken) return parsed;
      }
    } catch (err) {
      /* sessionStorage unavailable — fall through to a fresh identity */
    }
    const identity = {
      idempotencyKey: (crypto.randomUUID ? crypto.randomUUID() : randomHexToken(16)),
      orderAccessToken: randomHexToken(32),
    };
    try {
      sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    } catch (err) {
      /* session storage unavailable — identity still works for this one submit */
    }
    return identity;
  }

  function clearIdentity() {
    try {
      sessionStorage.removeItem(IDENTITY_KEY);
    } catch (err) {
      /* nothing to clean up if storage was never available */
    }
  }

  function fmt(n) {
    return window.BuddyCart.format(n);
  }

  function renderSummary(items) {
    const linesEl = document.querySelector('[data-checkout-lines]');
    linesEl.innerHTML = items
      .map(
        (i) => `
      <div class="checkout-summary__line">
        <span>${i.name}${i.subtitle ? ' — ' + i.subtitle : ''} &times;${i.qty}</span>
        <span>${fmt(i.unitPrice * i.qty)}</span>
      </div>`
      )
      .join('');
  }

  function buildOrderItems(cartItems) {
    return cartItems.map((i) => ({
      productId: i.customization.productId,
      variantId: i.customization.variantId,
      quantity: i.qty, // qty is the live, user-editable value — customization.quantity is a point-in-time mirror captured at add-to-cart
      personalization: i.customization.personalization,
      patches: i.customization.patches || [],
    }));
  }

  async function init() {
    BuddyNav.init('#site-nav', { active: '' });
    BuddyFooter.init('#site-footer', { showNewsletter: false });
    BuddyCart.initDrawer();

    const cartItems = BuddyCart.getItems();
    if (cartItems.length === 0) {
      document.querySelector('main .container').innerHTML =
        '<p class="future-page">Your cart is empty. <a href="catalog.html">Continue shopping</a>.</p>';
      return;
    }

    renderSummary(cartItems);
    const subtotal = BuddyCart.getSubtotal();
    document.querySelector('[data-checkout-subtotal]').textContent = fmt(subtotal);

    const settingsRes = await fetch('/api/public-settings');
    const settings = await settingsRes.json();
    const shipping = settings.shipping;

    let deliveryFee = 0;
    const deliveryRadioWrap = document.querySelector('[data-delivery-radio-wrap]');
    const unavailableNote = document.querySelector('[data-delivery-unavailable-note]');
    const addressFields = document.querySelector('[data-delivery-address-fields]');

    if (shipping.deliveryEnabled && shipping.flatRateDelivery != null) {
      deliveryFee = Number(shipping.flatRateDelivery);
      if (shipping.freeShippingThreshold != null && subtotal >= Number(shipping.freeShippingThreshold)) {
        deliveryFee = 0;
      }
      deliveryRadioWrap.hidden = false;
      document.querySelector('[data-delivery-fee-label]').textContent = deliveryFee > 0 ? '(+' + fmt(deliveryFee) + ')' : '(free)';
    } else {
      unavailableNote.hidden = false;
    }

    function updateTotals() {
      const method = document.querySelector('input[name="deliveryMethod"]:checked').value;
      const fee = method === 'delivery' ? deliveryFee : Number(shipping.pickupFee || 0);
      addressFields.hidden = method !== 'delivery';
      document.querySelector('[data-checkout-shipping]').textContent = fee > 0 ? fmt(fee) : 'Free';
      document.querySelector('[data-checkout-total]').textContent = fmt(subtotal + fee);
    }

    document.querySelectorAll('input[name="deliveryMethod"]').forEach((el) => {
      el.addEventListener('change', updateTotals);
    });
    updateTotals();

    const form = document.querySelector('[data-checkout-form]');
    const errorEl = document.querySelector('[data-checkout-error]');
    const submitBtn = document.querySelector('[data-submit-order]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Placing order…';

      try {
        const identity = loadOrCreateIdentity();
        const deliveryMethod = form.deliveryMethod.value;

        const payload = {
          idempotencyKey: identity.idempotencyKey,
          orderAccessToken: identity.orderAccessToken,
          customer: {
            fullName: form.fullName.value.trim(),
            email: form.email.value.trim(),
            mobile: form.mobile.value.trim(),
          },
          deliveryMethod,
          deliveryAddress:
            deliveryMethod === 'delivery'
              ? {
                  line1: form.line1.value.trim(),
                  line2: form.line2.value.trim(),
                  city: form.city.value.trim(),
                  province: form.province.value.trim(),
                  postalCode: form.postalCode.value.trim(),
                }
              : null,
          orderNotes: form.orderNotes.value.trim(),
          items: buildOrderItems(cartItems),
        };

        const res = await fetch('/api/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (!res.ok) {
          errorEl.textContent = data.message || data.error || 'Something went wrong. Please review your cart and try again.';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Place order';
          return;
        }

        // Only now — after the server has confirmed the order exists — is
        // it safe to clear the cart and this checkout attempt's identity.
        BuddyCart.clear();
        clearIdentity();
        window.location.href = 'order.html#token=' + identity.orderAccessToken;
      } catch (err) {
        errorEl.textContent = 'Network error — please try again. Your cart has not been cleared.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Place order';
      }
    });
  }

  init();
})();
