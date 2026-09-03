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

    const deliveryRadioWrap = document.querySelector('[data-delivery-radio-wrap]');
    const unavailableNote = document.querySelector('[data-delivery-unavailable-note]');
    const addressFields = document.querySelector('[data-delivery-address-fields]');
    const regionSelect = document.querySelector('[data-region-select]');

    const pickupFee = Number(shipping.pickupFee || 0);
    document.querySelector('[data-pickup-fee-label]').textContent = pickupFee > 0 ? '(+' + fmt(pickupFee) + ')' : '(free)';

    // Only regions the Owner has actually priced are offered. A region with
    // no configured rate is never shown as an option, so a customer can't
    // pick a destination the server would then refuse.
    const rates = shipping.rates || {};
    const REGION_LABELS = { luzon: 'Luzon', visayas: 'Visayas', mindanao: 'Mindanao' };
    const availableRegions = ['luzon', 'visayas', 'mindanao'].filter((r) => rates[r] != null);

    if (shipping.deliveryEnabled && availableRegions.length) {
      deliveryRadioWrap.hidden = false;
      regionSelect.innerHTML =
        '<option value="">Select a region…</option>' +
        availableRegions
          .map((r) => '<option value="' + r + '">' + REGION_LABELS[r] + ' — ' + fmt(Number(rates[r])) + '</option>')
          .join('');
    } else {
      unavailableNote.hidden = false;
    }

    /**
     * Display only. The browser showing a fee here does NOT decide it —
     * create-order.js independently recomputes the shipping fee and grand
     * total from Firestore settings and ignores anything this page sends
     * about money. If the two ever disagree, the server's number is the
     * one that counts and is what gets charged/snapshotted.
     */
    function estimatedShipping(method, region) {
      if (method === 'pickup') return { fee: pickupFee, label: 'Shipping — Pickup' };
      if (!region || rates[region] == null) return { fee: null, label: 'Shipping' };
      const base = Number(rates[region]);
      const free = shipping.freeShippingThreshold != null && subtotal >= Number(shipping.freeShippingThreshold);
      return { fee: free ? 0 : base, label: 'Shipping — ' + REGION_LABELS[region] };
    }

    function updateTotals() {
      const method = document.querySelector('input[name="deliveryMethod"]:checked').value;
      const region = regionSelect.value;
      addressFields.hidden = method !== 'delivery';

      const { fee, label } = estimatedShipping(method, region);
      document.querySelector('[data-checkout-shipping-label]').textContent = label;

      if (fee === null) {
        // No region chosen yet — never imply the order is cheaper than it is.
        document.querySelector('[data-checkout-shipping]').textContent = 'Select a region';
        document.querySelector('[data-checkout-total]').textContent = fmt(subtotal) + ' + shipping';
        return;
      }
      document.querySelector('[data-checkout-shipping]').textContent = fee > 0 ? fmt(fee) : 'Free';
      document.querySelector('[data-checkout-total]').textContent = fmt(subtotal + fee);
    }

    document.querySelectorAll('input[name="deliveryMethod"]').forEach((el) => {
      el.addEventListener('change', updateTotals);
    });
    regionSelect.addEventListener('change', updateTotals);
    updateTotals();

    const form = document.querySelector('[data-checkout-form]');
    const errorEl = document.querySelector('[data-checkout-error]');
    const submitBtn = document.querySelector('[data-submit-order]');

    // The server refuses order creation while checkout is off; saying so up
    // front is kinder than letting someone fill in the whole form first.
    if (settings.checkoutEnabled === false) {
      const closed = document.querySelector('[data-checkout-closed]');
      closed.hidden = false;
      closed.textContent = 'Online checkout isn’t open yet. Please contact us to place your order — we’ll be glad to help.';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Checkout unavailable';
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Placing order…';

      try {
        const identity = loadOrCreateIdentity();
        const deliveryMethod = form.deliveryMethod.value;

        if (deliveryMethod === 'delivery' && !regionSelect.value) {
          errorEl.textContent = 'Please choose a delivery region.';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Place order';
          return;
        }

        // Note what is NOT sent: no shippingFee, no subtotal, no total. The
        // server derives all three itself. Sending them would be pointless —
        // create-order.js never reads them.
        const payload = {
          idempotencyKey: identity.idempotencyKey,
          orderAccessToken: identity.orderAccessToken,
          customer: {
            fullName: form.fullName.value.trim(),
            email: form.email.value.trim(),
            mobile: form.mobile.value.trim(),
          },
          deliveryMethod,
          destinationRegion: deliveryMethod === 'delivery' ? regionSelect.value : null,
          deliveryAddress:
            deliveryMethod === 'delivery'
              ? {
                  line1: form.line1.value.trim(),
                  line2: form.line2.value.trim(),
                  barangay: form.barangay.value.trim(),
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
