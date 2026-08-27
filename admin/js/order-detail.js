import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';

let order = null;

const PAYMENT_LABELS = { awaiting_payment: 'Awaiting payment', pending_review: 'Pending review', paid: 'Paid', rejected: 'Rejected' };
const PAYMENT_BADGE = { awaiting_payment: 'admin-badge--inactive', pending_review: 'admin-badge--low', paid: 'admin-badge--active', rejected: 'admin-badge--inactive' };
const FULFILLMENT_LABELS = {
  unfulfilled: 'Unfulfilled',
  processing: 'Processing',
  ready_for_pickup: 'Ready for pickup',
  shipped: 'Shipped',
  completed: 'Completed',
};
const FULFILLMENT_BADGE = {
  unfulfilled: 'admin-badge--inactive',
  processing: 'admin-badge--low',
  ready_for_pickup: 'admin-badge--low',
  shipped: 'admin-badge--low',
  completed: 'admin-badge--active',
};
const INVENTORY_LABELS = { reserved: 'Reserved', locked: 'Inventory locked', consumed: 'Consumed', expired: 'Reservation expired' };
const INVENTORY_BADGE = { reserved: 'admin-badge--low', locked: 'admin-badge--low', consumed: 'admin-badge--active', expired: 'admin-badge--inactive' };
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

function fmtDate(v) {
  if (!v) return '—';
  const d = v._seconds ? new Date(v._seconds * 1000) : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtMoney(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH') + '.00';
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
      if (item.customization.text) extra += '<div class="hint">Name: "' + item.customization.text.value + '"</div>';
      if (item.customization.patches && item.customization.patches.length) {
        extra += '<div class="hint">Patches: ' + item.customization.patches.map((p) => p.patchName).join(', ') + '</div>';
      }
    }
    info.innerHTML =
      '<div class="order-line__name">' + item.productName + ' — ' + item.variantName + ' (SKU ' + item.sku + ')</div>' +
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
        ? '<div class="hint">Rejected: ' + (REJECTION_LABELS[a.rejectionCode] || a.rejectionCode) + (a.rejectionNote ? ' — ' + a.rejectionNote : '') + '</div>'
        : '';
      return (
        '<div style="border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px;">' +
        '<div><strong>' + a.paymentMethod + '</strong> — ref ' + a.paymentReference + ' — ' + a.payerName + '</div>' +
        '<div class="hint">Submitted ' + fmtDate(a.submittedAt) + ' · Status: ' + a.status + '</div>' +
        rejected +
        '</div>'
      );
    })
    .join('');
}

function renderPaymentActions() {
  const wrap = document.querySelector('[data-payment-actions]');
  wrap.innerHTML = '';
  if (order.paymentStatus !== 'pending_review') return;

  wrap.innerHTML = `
    <button type="button" class="admin-btn admin-btn--small" data-approve-payment>Approve payment</button>
    <button type="button" class="admin-btn admin-btn--danger admin-btn--small" data-reject-payment>Reject payment</button>
    <div data-reject-form hidden style="margin-top:10px;">
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
      <div class="admin-field">
        <label for="reject-note">Note <span class="hint">(required if "Other")</span></label>
        <textarea id="reject-note" data-reject-note maxlength="500"></textarea>
      </div>
      <button type="button" class="admin-btn admin-btn--danger admin-btn--small" data-confirm-reject>Confirm reject</button>
      <button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-cancel-reject>Cancel</button>
    </div>
    <p class="admin-note" data-payment-action-note></p>
  `;

  const noteEl = wrap.querySelector('[data-payment-action-note]');
  function setNote(text, isError) {
    noteEl.textContent = text || '';
    noteEl.className = 'admin-note' + (text ? (isError ? ' is-error' : ' is-success') : '');
  }

  wrap.querySelector('[data-approve-payment]').addEventListener('click', async () => {
    if (!confirm('Approve this payment?')) return;
    try {
      await apiFetch('/api/admin-approve-payment', { method: 'POST', body: JSON.stringify({ orderId: order.orderId }) });
      await load();
    } catch (err) {
      setNote(err.message, true);
    }
  });
  wrap.querySelector('[data-reject-payment]').addEventListener('click', () => {
    wrap.querySelector('[data-reject-form]').hidden = false;
  });
  wrap.querySelector('[data-cancel-reject]').addEventListener('click', () => {
    wrap.querySelector('[data-reject-form]').hidden = true;
  });
  wrap.querySelector('[data-confirm-reject]').addEventListener('click', async () => {
    const rejectionCode = wrap.querySelector('[data-reject-code]').value;
    const rejectionNote = wrap.querySelector('[data-reject-note]').value.trim();
    try {
      await apiFetch('/api/admin-reject-payment', { method: 'POST', body: JSON.stringify({ orderId: order.orderId, rejectionCode, rejectionNote }) });
      await load();
    } catch (err) {
      setNote(err.message, true);
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
    wrap.innerHTML = '<p class="hint">No further action.</p>';
    return;
  }

  wrap.innerHTML = options
    .map((s) => `<button type="button" class="admin-btn admin-btn--small" data-set-fulfillment="${s}">${FULFILLMENT_ACTION_LABELS[s]}</button>`)
    .join(' ');
  wrap.querySelectorAll('[data-set-fulfillment]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch('/api/admin-update-fulfillment', {
          method: 'POST',
          body: JSON.stringify({ orderId: order.orderId, fulfillmentStatus: btn.dataset.setFulfillment }),
        });
        await load();
      } catch (err) {
        alert(err.message);
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
  wrap.innerHTML = history
    .map(
      (h) =>
        '<div style="border-bottom:1px solid var(--border);padding:8px 0;font-size:13.5px;">' +
        '<strong>' + h.action + '</strong> — ' + fmtDate(h.at) + ' · ' + h.actorType + (h.actorId ? ' (' + h.actorId + ')' : '') +
        '</div>'
    )
    .join('');
}

async function load() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const data = await apiFetch('/api/admin-get-order?id=' + encodeURIComponent(id));
  order = data.order;

  document.querySelector('[data-order-loading]').hidden = true;
  document.querySelector('[data-order-detail]').hidden = false;

  document.querySelector('[data-order-number]').textContent = order.orderNumber + (order.isTest ? ' (TEST)' : '');
  document.querySelector('[data-customer-name]').textContent = order.customerName;
  document.querySelector('[data-customer-email]').textContent = order.customerEmail;
  document.querySelector('[data-customer-mobile]').textContent = order.customerMobile;
  document.querySelector('[data-order-notes]').textContent = order.orderNotes ? 'Notes: ' + order.orderNotes : '';
  document.querySelector('[data-delivery-method]').textContent = order.deliveryMethod === 'pickup' ? 'Pickup' : 'Delivery';

  const addrEl = document.querySelector('[data-delivery-address]');
  addrEl.innerHTML = order.deliveryAddress
    ? [order.deliveryAddress.line1, order.deliveryAddress.line2, order.deliveryAddress.city, order.deliveryAddress.province, order.deliveryAddress.postalCode]
        .filter(Boolean)
        .join('<br>')
    : '';

  renderLines();
  document.querySelector('[data-detail-subtotal]').textContent = fmtMoney(order.pricing.subtotal);
  document.querySelector('[data-detail-shipping]').textContent = order.pricing.shippingFee > 0 ? fmtMoney(order.pricing.shippingFee) : 'Free';
  document.querySelector('[data-detail-total]').textContent = fmtMoney(order.pricing.total);

  const paymentBadgeEl = document.querySelector('[data-payment-status-badge]');
  paymentBadgeEl.textContent = PAYMENT_LABELS[order.paymentStatus] || order.paymentStatus;
  paymentBadgeEl.className = 'admin-badge ' + (PAYMENT_BADGE[order.paymentStatus] || '');

  const fulfillmentBadgeEl = document.querySelector('[data-fulfillment-status-badge]');
  fulfillmentBadgeEl.textContent = FULFILLMENT_LABELS[order.fulfillmentStatus] || order.fulfillmentStatus;
  fulfillmentBadgeEl.className = 'admin-badge ' + (FULFILLMENT_BADGE[order.fulfillmentStatus] || '');

  const inventoryBadgeEl = document.querySelector('[data-inventory-status-badge]');
  inventoryBadgeEl.textContent = order.inventoryStatus ? (INVENTORY_LABELS[order.inventoryStatus] || order.inventoryStatus) : 'N/A (legacy test order)';
  inventoryBadgeEl.className = 'admin-badge ' + (order.inventoryStatus ? INVENTORY_BADGE[order.inventoryStatus] || '' : 'admin-badge--inactive');

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
