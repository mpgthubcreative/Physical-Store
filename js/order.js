/**
 * Adaptive order-status page. The access token lives ONLY in the URL
 * fragment (order.html#token=...) — never a query string, so it never
 * reaches a server access log or a referer header. It's read here,
 * client-side, and sent only in POST request bodies to get-order /
 * submit-payment, never anywhere else.
 */
(function () {
  const STATUS_LABELS = {
    awaiting_payment: 'Awaiting payment',
    pending_review: 'Payment under review',
    paid: 'Paid',
    rejected: 'Payment rejected',
  };
  const FULFILLMENT_LABELS = {
    unfulfilled: 'not yet started',
    processing: 'being processed',
    ready_for_pickup: 'ready for pickup',
    shipped: 'shipped',
    completed: 'completed',
  };
  const REJECTION_LABELS = {
    REFERENCE_NOT_FOUND: 'We could not find this payment reference.',
    AMOUNT_MISMATCH: 'The amount paid did not match the order total.',
    DUPLICATE_REFERENCE: 'This payment reference has already been used.',
    WRONG_PAYMENT_METHOD: 'This payment method does not match what was selected.',
    OTHER: 'There was an issue with this payment.',
  };

  function getTokenFromHash() {
    const hash = location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    return params.get('token');
  }

  function fmt(n) {
    return window.BuddyCart.format(n);
  }

  async function loadOrder(token) {
    const res = await fetch('/api/get-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return null;
    return res.json();
  }

  function renderLines(order) {
    const wrap = document.querySelector('[data-order-lines]');
    wrap.innerHTML = '';
    order.items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'order-line';

      const previewEl = document.createElement('div');
      previewEl.className = 'order-line__preview';
      if (item.customization) {
        window.BuddyOrderPreview.render(previewEl, item.customization);
      } else if (item.thumbnailUrl) {
        previewEl.style.backgroundImage = 'url("' + item.thumbnailUrl + '")';
        previewEl.style.backgroundSize = 'cover';
        previewEl.style.backgroundPosition = 'center';
      }

      const info = document.createElement('div');
      info.className = 'order-line__info';
      info.innerHTML =
        '<div class="order-line__name">' + item.productName + ' — ' + item.variantName + '</div>' +
        '<div class="order-line__sub">Qty ' + item.quantity + ' · ' + fmt(item.unitPrice) + ' each</div>';

      const price = document.createElement('div');
      price.className = 'order-line__price';
      price.textContent = fmt(item.lineTotal);

      row.appendChild(previewEl);
      row.appendChild(info);
      row.appendChild(price);
      wrap.appendChild(row);
    });
  }

  function renderPaymentSection(order, paymentMethods, token, onUpdated) {
    const section = document.querySelector('[data-payment-section]');
    section.innerHTML = '';

    if (order.paymentStatus === 'paid') {
      section.innerHTML =
        '<p class="order-status-msg is-success">Payment received. Your order is ' +
        (FULFILLMENT_LABELS[order.fulfillmentStatus] || order.fulfillmentStatus) + '.</p>';
      return;
    }
    if (order.paymentStatus === 'pending_review') {
      section.innerHTML = '<p class="order-status-msg">We\'re reviewing your payment. This page will update once it\'s confirmed.</p>';
      return;
    }

    if (order.paymentStatus === 'rejected' && order.latestRejection) {
      const msg = REJECTION_LABELS[order.latestRejection.code] || REJECTION_LABELS.OTHER;
      const note = order.latestRejection.note ? ' ' + order.latestRejection.note : '';
      const p = document.createElement('p');
      p.className = 'order-status-msg is-error';
      p.textContent = 'Your last payment submission was not accepted: ' + msg + note + ' Please review and resubmit below.';
      section.appendChild(p);
    }

    if (!paymentMethods.length) {
      const p = document.createElement('p');
      p.className = 'order-status-msg';
      p.textContent = 'Payment instructions are being finalized — please check back soon or contact us.';
      section.appendChild(p);
      return;
    }

    const instructions = document.createElement('div');
    instructions.innerHTML = paymentMethods
      .map(
        (m) =>
          '<div class="payment-method-card"><h3>' + m.label + '</h3>' +
          (m.bankName ? '<p>Bank: ' + m.bankName + '</p>' : '') +
          (m.accountName ? '<p>Account name: ' + m.accountName + '</p>' : '') +
          (m.accountNumber ? '<p>Account number: ' + m.accountNumber + '</p>' : '') +
          (m.instructions ? '<p>' + m.instructions + '</p>' : '') +
          '</div>'
      )
      .join('');
    section.appendChild(instructions);

    const form = document.createElement('form');
    form.setAttribute('data-payment-form', '');
    form.innerHTML =
      '<div class="field"><label for="pay-method">Payment method</label>' +
      '<select id="pay-method" name="paymentMethod" required>' +
      paymentMethods.map((m) => '<option value="' + m.id + '">' + m.label + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label for="pay-ref">Payment reference number</label>' +
      '<input id="pay-ref" name="paymentReference" type="text" required maxlength="100" /></div>' +
      '<div class="field"><label for="pay-payer">Name used for payment</label>' +
      '<input id="pay-payer" name="payerName" type="text" required maxlength="100" /></div>' +
      '<button type="submit" class="btn-coral">Submit payment</button>' +
      '<p class="form-note is-error" data-payment-form-error></p>';
    section.appendChild(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = form.querySelector('[data-payment-form-error]');
      errorEl.textContent = '';
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      try {
        const attemptId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
        const res = await fetch('/api/submit-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            attemptId,
            paymentMethod: form.paymentMethod.value,
            paymentReference: form.paymentReference.value.trim(),
            payerName: form.payerName.value.trim(),
          }),
        });
        const result = await res.json();
        if (!res.ok) {
          errorEl.textContent = result.error || 'Something went wrong. Please try again.';
          submitBtn.disabled = false;
          return;
        }
        onUpdated();
      } catch (err) {
        errorEl.textContent = 'Network error — please try again.';
        submitBtn.disabled = false;
      }
    });
  }

  async function init() {
    BuddyNav.init('#site-nav', { active: '' });
    BuddyFooter.init('#site-footer', { showNewsletter: false });
    BuddyCart.initDrawer();

    const token = getTokenFromHash();
    const root = document.querySelector('[data-order-root]');
    const loading = document.querySelector('[data-order-loading]');

    if (!token) {
      loading.hidden = true;
      root.innerHTML = '<p class="future-page">This order link is missing or invalid.</p>';
      return;
    }

    async function refreshAndRender() {
      const data = await loadOrder(token);
      if (!data) {
        loading.hidden = true;
        root.innerHTML = '<p class="future-page">We could not find that order.</p>';
        return;
      }
      loading.hidden = true;
      document.querySelector('[data-order-content]').hidden = false;

      const { order, paymentMethods } = data;
      document.querySelector('[data-order-number]').textContent = order.orderNumber;
      document.querySelector('[data-order-status-badge]').textContent = STATUS_LABELS[order.paymentStatus] || order.paymentStatus;
      document.querySelector('[data-order-subtotal]').textContent = fmt(order.pricing.subtotal);
      document.querySelector('[data-order-shipping]').textContent = order.pricing.shippingFee > 0 ? fmt(order.pricing.shippingFee) : 'Free';
      document.querySelector('[data-order-total]').textContent = fmt(order.pricing.total);

      renderLines(order);
      renderPaymentSection(order, paymentMethods, token, refreshAndRender);
    }

    await refreshAndRender();
  }

  init();
})();
