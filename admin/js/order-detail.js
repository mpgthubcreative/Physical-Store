import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { confirmAction, showToast, setButtonBusy } from './admin-ui.js';
import { PAYMENT_STATUS, FULFILLMENT_STATUS, INVENTORY_STATUS, fmtMoney, fmtDateTime, escapeHtml } from './admin-format.js';

function applyBadge(selector, map, key, fallbackLabel) {
  const el = document.querySelector(selector);
  const entry = map[key];
  el.textContent = entry ? entry.label : fallbackLabel || key || '—';
  el.className = 'admin-badge admin-badge--' + (entry ? entry.tone : 'neutral');
}

let order = null;

const REJECTION_LABELS = {
  REFERENCE_NOT_FOUND: 'Reference not found',
  AMOUNT_MISMATCH: 'Amount mismatch',
  DUPLICATE_REFERENCE: 'Duplicate reference',
  WRONG_PAYMENT_METHOD: 'Wrong payment method',
  OTHER: 'Other',
};
const FULFILLMENT_ACTION_LABELS = { processing: 'Mark processing', ready_for_pickup: 'Mark ready for pickup', shipped: 'Mark shipped', completed: 'Mark completed' };

function nextFulfillmentOptions(current, deliveryMethod) {
  if (current === 'unfulfilled') return ['processing'];
  if (current === 'processing') return deliveryMethod === 'pickup' ? ['ready_for_pickup'] : ['shipped'];
  if (current === 'ready_for_pickup' || current === 'shipped') return ['completed'];
  return [];
}

function renderLines() {
  const wrap = document.querySelector('[data-detail-lines]');
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
    let extra = '';
    if (item.customization) {
      if (item.customization.text) extra += '<div class="hint">Name: "' + escapeHtml(item.customization.text.value) + '"</div>';
      if (item.customization.patches && item.customization.patches.length) {
        extra += '<div class="hint">Patches: ' + item.customization.patches.map((p) => escapeHtml(p.patchName)).join(', ') + '</div>';
      }
    }
    info.innerHTML =
      '<div class="order-line__name">' + escapeHtml(item.productName) + ' — ' + escapeHtml(item.variantName) + ' <span class="admin-row-sub">SKU ' + escapeHtml(item.sku) + '</span></div>' +
      '<div class="order-line__sub">Qty ' + item.quantity + ' × ' + fmtMoney(item.pricing.unitPrice) + '</div>' + extra;

    const price = document.createElement('div');
    price.className = 'order-line__price';
    price.textContent = fmtMoney(item.pricing.lineTotal);

    row.appendChild(previewEl);
    row.appendChild(info);
    row.appendChild(price);
    wrap.appendChild(row);
  });
}

function renderPaymentAttempts() {
  const wrap = document.querySelector('[data-payment-attempts]');
  const attempts = order.paymentAttempts || [];
  if (!attempts.length) {
    wrap.innerHTML = '<p class="hint">No payment attempts yet.</p>';
    return;
  }
  wrap.innerHTML = attempts
    .map((a) => {
      const rejected = a.status === 'rejected'
        ? '<div class="hint" style="color:var(--admin-danger-fg);">Rejected: ' + (REJECTION_LABELS[a.rejectionCode] || a.rejectionCode) + (a.rejectionNote ? ' — ' + escapeHtml(a.rejectionNote) : '') + '</div>'
        : '';
      return (
        '<div style="border:1px solid var(--border);border-radius:var(--admin-radius-sm);padding:12px;margin-bottom:8px;">' +
        '<div style="font-weight:700;">' + escapeHtml(a.paymentMethod) + ' <span class="admin-row-sub" style="font-weight:500;">ref ' + escapeHtml(a.paymentReference) + ' · ' + escapeHtml(a.payerName) + '</span></div>' +
        '<div class="hint">Submitted ' + fmtDateTime(a.submittedAt) + ' · Status: ' + a.status + '</div>' +
        rejected +
        '</div>'
      );
    })
    .join('');
}

function renderPaymentActions() {
  const wrap = document.querySelector('[data-payment-actions]');
  wrap.innerHTML = '';
  if (order.paymentStatus !== 'pending_review') {
    wrap.innerHTML = '<p class="hint">No action needed right now.</p>';
    return;
  }

  wrap.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <button type="button" class="admin-btn admin-btn--small" data-approve-payment>Approve payment</button>
      <button type="button" class="admin-btn admin-btn--danger-ghost admin-btn--small" data-reject-payment>Reject payment</button>
    </div>
    <div data-reject-form hidden style="margin-top:14px;">
      <div class="admin-field">
        <label for="reject-code">Reason</label>
        <select id="reject-code" data-reject-code>
          <option value="REFERENCE_NOT_FOUND">Reference not found</option>
          <option value="AMOUNT_MISMATCH">Amount mismatch</option>
          <option value="DUPLICATE_REFERENCE">Duplicate reference</option>
          <option value="WRONG_PAYMENT_METHOD">Wrong payment method</option>
          <option value="OTHER">Other</option>
        </select>
      </div>
      <div class="admin-field" style="margin-top:10px;">
        <label for="reject-note">Note <span class="hint">(required if "Other")</span></label>
        <textarea id="reject-note" data-reject-note maxlength="500"></textarea>
      </div>
      <div style="display:flex;gap:10px;margin-top:12px;">
        <button type="button" class="admin-btn admin-btn--danger admin-btn--small" data-confirm-reject>Confirm reject</button>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-cancel-reject>Cancel</button>
      </div>
    </div>
  `;

  const approveBtn = wrap.querySelector('[data-approve-payment]');
  approveBtn.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Approve this payment?',
      message: 'This permanently deducts inventory and marks the order as paid. This cannot be undone.',
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    setButtonBusy(approveBtn, true, 'Approving…');
    try {
      await apiFetch('/api/admin-approve-payment', { method: 'POST', body: JSON.stringify({ orderId: order.orderId }) });
      showToast('Payment approved.', 'success');
      await load();
    } catch (err) {
      showToast(err.message, 'error');
      setButtonBusy(approveBtn, false);
    }
  });
  wrap.querySelector('[data-reject-payment]').addEventListener('click', () => {
    wrap.querySelector('[data-reject-form]').hidden = false;
  });
  wrap.querySelector('[data-cancel-reject]').addEventListener('click', () => {
    wrap.querySelector('[data-reject-form]').hidden = true;
  });
  const confirmRejectBtn = wrap.querySelector('[data-confirm-reject]');
  confirmRejectBtn.addEventListener('click', async () => {
    const rejectionCode = wrap.querySelector('[data-reject-code]').value;
    const rejectionNote = wrap.querySelector('[data-reject-note]').value.trim();
    if (rejectionCode === 'OTHER' && !rejectionNote) {
      showToast('A note is required when selecting "Other".', 'error');
      return;
    }
    setButtonBusy(confirmRejectBtn, true, 'Rejecting…');
    try {
      await apiFetch('/api/admin-reject-payment', { method: 'POST', body: JSON.stringify({ orderId: order.orderId, rejectionCode, rejectionNote }) });
      showToast('Payment rejected.', 'success');
      await load();
    } catch (err) {
      showToast(err.message, 'error');
      setButtonBusy(confirmRejectBtn, false);
    }
  });
}

function renderFulfillmentActions() {
  const wrap = document.querySelector('[data-fulfillment-actions]');
  wrap.innerHTML = '';

  if (order.paymentStatus !== 'paid') {
    wrap.innerHTML = '<p class="hint">Fulfillment can begin once payment is approved.</p>';
    return;
  }
  const options = nextFulfillmentOptions(order.fulfillmentStatus, order.deliveryMethod);
  if (!options.length) {
    wrap.innerHTML = '<p class="hint">No further action — this order is complete.</p>';
    return;
  }

  wrap.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;">
    ${options.map((s) => `<button type="button" class="admin-btn admin-btn--small" data-set-fulfillment="${s}">${FULFILLMENT_ACTION_LABELS[s]}</button>`).join('')}
  </div>`;
  wrap.querySelectorAll('[data-set-fulfillment]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      setButtonBusy(btn, true, 'Updating…');
      try {
        await apiFetch('/api/admin-update-fulfillment', {
          method: 'POST',
          body: JSON.stringify({ orderId: order.orderId, fulfillmentStatus: btn.dataset.setFulfillment }),
        });
        showToast('Fulfillment updated.', 'success');
        await load();
      } catch (err) {
        showToast(err.message, 'error');
        setButtonBusy(btn, false);
      }
    });
  });
}

function renderHistory() {
  const wrap = document.querySelector('[data-order-history]');
  const history = order.history || [];
  if (!history.length) {
    wrap.innerHTML = '<p class="hint">No history yet.</p>';
    return;
  }
  wrap.innerHTML = `<div class="admin-timeline">${history
    .slice()
    .reverse()
    .map(
      (h) => `
      <div class="admin-timeline-item">
        <div class="admin-timeline-item__action">${h.action.replace(/_/g, ' ')}</div>
        <div class="admin-timeline-item__meta">${fmtDateTime(h.at)} · ${h.actorType}${h.actorId ? ' (' + escapeHtml(h.actorId) + ')' : ''}</div>
      </div>`
    )
    .join('')}</div>`;
}

async function load() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const data = await apiFetch('/api/admin-get-order?id=' + encodeURIComponent(id));
  order = data.order;

  document.querySelector('[data-order-loading]').hidden = true;
  document.querySelector('[data-order-detail]').hidden = false;

  document.querySelector('[data-order-number]').textContent = order.orderNumber + (order.isTest ? ' (TEST)' : '');
  document.querySelector('[data-order-date]').textContent = fmtDateTime(order.createdAt);
  document.querySelector('[data-customer-name]').textContent = order.customerName;
  document.querySelector('[data-customer-email]').textContent = order.customerEmail;
  document.querySelector('[data-customer-mobile]').textContent = order.customerMobile;
  document.querySelector('[data-order-notes]').textContent = order.orderNotes ? 'Notes: ' + order.orderNotes : '';
  document.querySelector('[data-delivery-method]').textContent = order.deliveryMethod === 'pickup' ? 'Pickup' : 'Delivery';

  const addrEl = document.querySelector('[data-delivery-address]');
  addrEl.innerHTML = order.deliveryAddress
    ? [order.deliveryAddress.line1, order.deliveryAddress.line2, order.deliveryAddress.city, order.deliveryAddress.province, order.deliveryAddress.postalCode]
        .filter(Boolean)
        .map(escapeHtml)
        .join('<br>')
    : '<span class="hint">No address on file.</span>';

  renderLines();
  document.querySelector('[data-detail-subtotal]').textContent = fmtMoney(order.pricing.subtotal);
  document.querySelector('[data-detail-shipping]').textContent = order.pricing.shippingFee > 0 ? fmtMoney(order.pricing.shippingFee) : 'Free';
  document.querySelector('[data-detail-total]').textContent = fmtMoney(order.pricing.total);

  applyBadge('[data-payment-status-badge]', PAYMENT_STATUS, order.paymentStatus);
  applyBadge('[data-fulfillment-status-badge]', FULFILLMENT_STATUS, order.fulfillmentStatus);
  applyBadge('[data-inventory-status-badge]', INVENTORY_STATUS, order.inventoryStatus, order.inventoryStatus ? undefined : 'N/A');

  renderPaymentAttempts();
  renderPaymentActions();
  renderFulfillmentActions();
  renderHistory();
}

async function init() {
  await requireSession();
  await renderAdminShell('orders');
  await load();
}

init();
