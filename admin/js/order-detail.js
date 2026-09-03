/**
 * Admin -> Order Detail.
 *
 * Phase 5D.2 reorganizes this screen around the two things an Owner
 * actually does here — review a payment, then fulfill the order — and makes
 * both unmistakable rather than small secondary blocks.
 *
 * Nothing about the underlying transactions changed: approve/reject still
 * call admin-approve-payment.js / admin-reject-payment.js (which own the
 * Phase 5D inventory consumption and reservation lifecycle), and fulfillment
 * still calls admin-update-fulfillment.js (which owns the transition table).
 * This file only decides what to show and which single next action to
 * offer; the server re-validates every transition regardless.
 *
 * ---- Historical orders ----
 * Orders created before Phase 5D.2 have no destinationRegion, no barangay,
 * and no courier/trackingNumber. Every renderer below treats those as
 * "Not recorded" rather than erroring or printing "undefined". Nothing is
 * ever backfilled, and pricing is always displayed from the order's own
 * frozen snapshot — never recomputed from current shipping settings.
 */
import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { confirmAction, showToast, setButtonBusy } from './admin-ui.js';
import { PAYMENT_STATUS, FULFILLMENT_STATUS, INVENTORY_STATUS, destinationLabel, fmtMoney, fmtDateTime, escapeHtml } from './admin-format.js';

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

// The action label for moving INTO each status, phrased as the operational
// instruction the Owner is actually carrying out.
const FULFILLMENT_ACTION_LABELS = {
  processing: 'Start Processing',
  ready_for_pickup: 'Mark Ready for Pickup',
  shipped: 'Mark as Shipped',
  completed: 'Complete Order',
};

// The full path an order of each kind travels. Rendered as a rail so the
// Owner can see where this order sits and what remains — not just its
// current status in isolation.
const PICKUP_PATH = ['unfulfilled', 'processing', 'ready_for_pickup', 'completed'];
const DELIVERY_PATH = ['unfulfilled', 'processing', 'shipped', 'completed'];

function fulfillmentPath(deliveryMethod) {
  return deliveryMethod === 'pickup' ? PICKUP_PATH : DELIVERY_PATH;
}

/** Mirrors admin-update-fulfillment.js's VALID_FROM table. The server is still the authority. */
function nextFulfillmentOptions(current, deliveryMethod) {
  if (current === 'unfulfilled') return ['processing'];
  if (current === 'processing') return deliveryMethod === 'pickup' ? ['ready_for_pickup'] : ['shipped'];
  if (current === 'ready_for_pickup' || current === 'shipped') return ['completed'];
  return [];
}

/* ---------------------------------------------------------------------
   Order lines
--------------------------------------------------------------------- */

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

/* ---------------------------------------------------------------------
   PAYMENT REVIEW
--------------------------------------------------------------------- */

function latestAttempt() {
  const attempts = order.paymentAttempts || [];
  return attempts.length ? attempts[attempts.length - 1] : null;
}

function renderPaymentBanner() {
  const card = document.querySelector('[data-payment-card]');
  const wrap = document.querySelector('[data-payment-banner]');
  const status = order.paymentStatus;

  card.classList.toggle('admin-op-card--attention', status === 'pending_review');

  const BANNERS = {
    pending_review: { tone: 'attention', text: 'Payment requires review' },
    paid: { tone: 'positive', text: 'Payment approved' },
    rejected: { tone: 'danger', text: 'Payment rejected — awaiting a new submission' },
    awaiting_payment: { tone: 'neutral', text: 'Awaiting customer payment' },
  };
  const banner = BANNERS[status] || { tone: 'neutral', text: status };
  wrap.innerHTML = `<div class="admin-op-card__banner admin-op-card__banner--${banner.tone}">${banner.text}</div>`;
}

/**
 * The amount callout. Reads straight from the order's frozen pricing
 * snapshot so the Owner can compare it to a GCash/bank transfer without
 * doing any arithmetic themselves.
 */
function renderPaymentExpected() {
  const p = order.pricing || {};
  const shippingLabel = order.deliveryMethod === 'pickup' ? 'Shipping — Pickup' : 'Shipping — ' + destinationLabel(order);
  const shippingValue = p.shippingFee > 0 ? fmtMoney(p.shippingFee) : 'Free';

  document.querySelector('[data-payment-expected]').innerHTML = `
    <div class="admin-amount-callout">
      <div class="admin-amount-callout__label">Amount expected</div>
      <div class="admin-amount-callout__value">${fmtMoney(p.total)}</div>
      <div class="admin-amount-callout__break">
        <div class="admin-amount-callout__row"><span>Items subtotal</span><span>${fmtMoney(p.subtotal)}</span></div>
        <div class="admin-amount-callout__row"><span>${escapeHtml(shippingLabel)}</span><span>${shippingValue}</span></div>
        <div class="admin-amount-callout__row"><strong>Grand total</strong><strong>${fmtMoney(p.total)}</strong></div>
      </div>
    </div>`;
}

/** The submission currently under review (or the most recent one). */
function renderPaymentCurrent() {
  const wrap = document.querySelector('[data-payment-current]');
  const attempt = latestAttempt();

  if (!attempt) {
    wrap.innerHTML = '<p class="hint">The customer has not submitted a payment yet.</p>';
    return;
  }

  const rejected =
    attempt.status === 'rejected'
      ? `<div class="admin-inline-note admin-inline-note--danger" style="margin-top:14px;">
           Rejected: ${escapeHtml(REJECTION_LABELS[attempt.rejectionCode] || attempt.rejectionCode || 'Unknown reason')}${attempt.rejectionNote ? ' — ' + escapeHtml(attempt.rejectionNote) : ''}
         </div>`
      : '';

  wrap.innerHTML = `
    <div class="admin-kv" style="margin-bottom:4px;">
      <div><div class="admin-kv__k">Payment method</div><div class="admin-kv__v">${escapeHtml(attempt.paymentMethod)}</div></div>
      <div><div class="admin-kv__k">Payer name</div><div class="admin-kv__v">${escapeHtml(attempt.payerName)}</div></div>
      <div><div class="admin-kv__k">Reference number</div><div class="admin-kv__v is-mono">${escapeHtml(attempt.paymentReference)}</div></div>
      <div><div class="admin-kv__k">Submitted</div><div class="admin-kv__v">${fmtDateTime(attempt.submittedAt)}</div></div>
    </div>
    ${rejected}`;
}

function renderPaymentActions() {
  const wrap = document.querySelector('[data-payment-actions]');
  wrap.innerHTML = '';
  if (order.paymentStatus !== 'pending_review') return;

  wrap.innerHTML = `
    <hr class="admin-divider" />
    <div class="admin-action-row">
      <button type="button" class="admin-btn admin-btn--primary-action" data-approve-payment>Approve Payment</button>
      <button type="button" class="admin-btn admin-btn--danger-ghost admin-btn--primary-action" data-reject-payment>Reject Payment</button>
    </div>
    <div data-reject-form hidden style="margin-top:18px;">
      <div class="admin-field">
        <label for="reject-code">Reason <span class="req">*</span></label>
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
      <div class="admin-action-row" style="margin-top:12px;">
        <button type="button" class="admin-btn admin-btn--danger admin-btn--small" data-confirm-reject>Confirm reject</button>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-cancel-reject>Cancel</button>
      </div>
    </div>`;

  const approveBtn = wrap.querySelector('[data-approve-payment]');
  approveBtn.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Approve this payment?',
      message: `Confirm you received ${fmtMoney(order.pricing.total)}. This permanently deducts inventory and marks the order as paid. This cannot be undone.`,
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

function renderPaymentAttempts() {
  const wrap = document.querySelector('[data-payment-attempts]');
  const attempts = order.paymentAttempts || [];
  if (!attempts.length) {
    wrap.innerHTML = '<p class="hint">No payment attempts yet.</p>';
    return;
  }
  // Newest first. Rejected attempts are never removed — the full history of
  // what the customer tried stays visible forever.
  wrap.innerHTML = attempts
    .map((a, i) => ({ a, i }))
    .reverse()
    .map(({ a, i }) => {
      const isCurrent = i === attempts.length - 1;
      const rejected =
        a.status === 'rejected'
          ? '<div class="hint" style="color:var(--admin-danger-fg);margin-top:6px;">Rejected: ' +
            escapeHtml(REJECTION_LABELS[a.rejectionCode] || a.rejectionCode || '') +
            (a.rejectionNote ? ' — ' + escapeHtml(a.rejectionNote) : '') +
            '</div>'
          : '';
      return `
        <div class="admin-attempt${isCurrent ? ' is-current' : ''}">
          <div class="admin-attempt__head">
            <span class="admin-attempt__method">Attempt ${i + 1} · ${escapeHtml(a.paymentMethod)}</span>
            <span class="admin-badge admin-badge--${a.status === 'approved' ? 'positive' : a.status === 'rejected' ? 'danger' : 'warning'}">${escapeHtml(a.status)}</span>
          </div>
          <div class="hint" style="margin-top:6px;">
            Ref <strong>${escapeHtml(a.paymentReference)}</strong> · ${escapeHtml(a.payerName)} · submitted ${fmtDateTime(a.submittedAt)}
          </div>
          ${rejected}
        </div>`;
    })
    .join('');
}

/* ---------------------------------------------------------------------
   FULFILLMENT
--------------------------------------------------------------------- */

function renderFulfillmentBanner() {
  const card = document.querySelector('[data-fulfillment-card]');
  const wrap = document.querySelector('[data-fulfillment-banner]');
  const status = order.fulfillmentStatus;
  const paid = order.paymentStatus === 'paid';

  // An order that is paid but not yet finished is the Owner's actual work
  // queue — highlight it the same way a pending payment is highlighted.
  const needsAction = paid && status !== 'completed';
  card.classList.toggle('admin-op-card--attention', needsAction);

  const entry = FULFILLMENT_STATUS[status] || { label: status };
  let tone = 'neutral';
  if (status === 'completed') tone = 'positive';
  else if (needsAction) tone = 'attention';

  wrap.innerHTML = `<div class="admin-op-card__banner admin-op-card__banner--${tone}">Fulfillment — ${escapeHtml(entry.label)}</div>`;

  document.querySelector('[data-fulfillment-desc]').textContent = paid
    ? order.deliveryMethod === 'pickup'
      ? 'This is a pickup order. Move it along as you prepare and hand it over.'
      : 'This is a delivery order. Move it along as you prepare and ship it.'
    : 'Payment and fulfillment are tracked independently — an approved payment does not fulfill the order for you.';
}

/** The whole path, with completed steps behind and the current step marked. */
function renderFulfillmentSteps() {
  const path = fulfillmentPath(order.deliveryMethod);
  const currentIndex = path.indexOf(order.fulfillmentStatus);

  document.querySelector('[data-fulfillment-steps]').innerHTML =
    '<div class="admin-steps">' +
    path
      .map((status, i) => {
        const cls = i < currentIndex ? 'is-done' : i === currentIndex ? 'is-current' : '';
        const label = (FULFILLMENT_STATUS[status] || { label: status }).label;
        const arrow = i < path.length - 1 ? '<span class="admin-step__arrow">→</span>' : '';
        return `<span class="admin-step ${cls}"><span class="admin-step__dot"></span>${escapeHtml(label)}</span>${arrow}`;
      })
      .join('') +
    '</div>';
}

/** Courier + tracking, once a delivery order has actually shipped. */
function renderShipmentDetails() {
  const wrap = document.querySelector('[data-shipment-details]');
  const shipped = order.fulfillmentStatus === 'shipped' || order.fulfillmentStatus === 'completed';

  if (order.deliveryMethod !== 'delivery' || !shipped) {
    wrap.innerHTML = '';
    return;
  }

  // A delivery order shipped before Phase 5D.2 has no courier recorded.
  // Show that honestly instead of leaving the section blank.
  const courier = order.courier
    ? escapeHtml(order.courier)
    : '<span class="is-muted">Not recorded</span>';
  const tracking = order.trackingNumber
    ? '<span class="is-mono">' + escapeHtml(order.trackingNumber) + '</span>'
    : '<span class="is-muted">None provided</span>';

  wrap.innerHTML = `
    <div class="admin-amount-callout" style="margin-bottom:18px;">
      <div class="admin-kv">
        <div><div class="admin-kv__k">Courier</div><div class="admin-kv__v">${courier}</div></div>
        <div><div class="admin-kv__k">Tracking number</div><div class="admin-kv__v">${tracking}</div></div>
      </div>
    </div>`;
}

/**
 * A small modal for the shipped transition. Courier is required, tracking
 * number is optional — some local/provincial couriers don't issue one.
 * Resolves to { courier, trackingNumber } or null if cancelled.
 */
function promptShipmentDetails() {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'admin-modal-scrim';
    scrim.innerHTML = `
      <div class="admin-modal" role="dialog" aria-modal="true" aria-labelledby="ship-modal-title">
        <div class="admin-modal__icon is-neutral">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
        </div>
        <h2 id="ship-modal-title">Mark as Shipped</h2>
        <p>Record how this order went out. This is kept on the order permanently.</p>
        <div class="admin-field">
          <label for="ship-courier">Courier <span class="req">*</span></label>
          <input id="ship-courier" maxlength="80" placeholder="e.g. J&amp;T, LBC, Lalamove" />
        </div>
        <div class="admin-field" style="margin-top:12px;">
          <label for="ship-tracking">Tracking number <span class="hint">(optional)</span></label>
          <input id="ship-tracking" maxlength="100" placeholder="Leave blank if none" />
        </div>
        <p class="admin-note is-error" data-ship-error style="min-height:0;"></p>
        <div class="admin-modal__actions" style="margin-top:16px;">
          <button type="button" class="admin-btn admin-btn--ghost" data-ship-cancel>Cancel</button>
          <button type="button" class="admin-btn" data-ship-confirm>Mark as Shipped</button>
        </div>
      </div>`;
    document.body.appendChild(scrim);
    requestAnimationFrame(() => scrim.classList.add('is-open'));

    const close = (result) => {
      scrim.classList.remove('is-open');
      document.removeEventListener('keydown', onKeydown);
      setTimeout(() => scrim.remove(), 160);
      resolve(result);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') close(null);
    };

    scrim.querySelector('[data-ship-cancel]').addEventListener('click', () => close(null));
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) close(null);
    });
    scrim.querySelector('[data-ship-confirm]').addEventListener('click', () => {
      const courier = scrim.querySelector('#ship-courier').value.trim();
      const trackingNumber = scrim.querySelector('#ship-tracking').value.trim();
      if (!courier) {
        scrim.querySelector('[data-ship-error]').textContent = 'Courier is required.';
        return;
      }
      close({ courier, trackingNumber });
    });
    document.addEventListener('keydown', onKeydown);
    scrim.querySelector('#ship-courier').focus();
  });
}

async function applyFulfillment(targetStatus, btn) {
  let extra = {};

  // Delivery orders capture courier/tracking at the moment of shipping.
  if (targetStatus === 'shipped') {
    const details = await promptShipmentDetails();
    if (!details) return;
    extra = details;
  }
  if (targetStatus === 'completed') {
    const ok = await confirmAction({
      title: 'Complete this order?',
      message: 'Mark this order as fully completed. This is the final fulfillment state.',
      confirmLabel: 'Complete order',
    });
    if (!ok) return;
  }

  setButtonBusy(btn, true, 'Updating…');
  try {
    await apiFetch('/api/admin-update-fulfillment', {
      method: 'POST',
      body: JSON.stringify({ orderId: order.orderId, fulfillmentStatus: targetStatus, ...extra }),
    });
    showToast('Fulfillment updated.', 'success');
    await load();
  } catch (err) {
    showToast(err.message, 'error');
    setButtonBusy(btn, false);
  }
}

function renderFulfillmentActions() {
  const wrap = document.querySelector('[data-fulfillment-actions]');
  wrap.innerHTML = '';

  // Unpaid: the section still renders in full (status, path, explanation) —
  // it never disappears. Only the action button is withheld, with the
  // reason stated plainly.
  if (order.paymentStatus !== 'paid') {
    wrap.innerHTML = `
      <div class="admin-inline-note admin-inline-note--neutral">
        <strong>Payment must be approved before fulfillment can begin.</strong>
        This order is currently <em>${escapeHtml((PAYMENT_STATUS[order.paymentStatus] || {}).label || order.paymentStatus)}</em>.
      </div>`;
    return;
  }

  const options = nextFulfillmentOptions(order.fulfillmentStatus, order.deliveryMethod);
  if (!options.length) {
    wrap.innerHTML = '<div class="admin-inline-note admin-inline-note--info">This order is complete. No further fulfillment action is needed.</div>';
    return;
  }

  // Exactly the next valid step — never a free-form status dropdown that
  // would let an Owner pick an invalid jump the server would reject anyway.
  wrap.innerHTML =
    '<div class="admin-action-row">' +
    options
      .map((s) => `<button type="button" class="admin-btn admin-btn--primary-action" data-set-fulfillment="${s}">${FULFILLMENT_ACTION_LABELS[s]}</button>`)
      .join('') +
    '</div>';

  wrap.querySelectorAll('[data-set-fulfillment]').forEach((btn) => {
    btn.addEventListener('click', () => applyFulfillment(btn.dataset.setFulfillment, btn));
  });
}

/* ---------------------------------------------------------------------
   History
--------------------------------------------------------------------- */

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
    .map((h) => {
      const meta = h.meta || {};
      const extra = meta.courier ? ` · ${escapeHtml(meta.courier)}${meta.trackingNumber ? ' ' + escapeHtml(meta.trackingNumber) : ''}` : '';
      return `
      <div class="admin-timeline-item">
        <div class="admin-timeline-item__action">${escapeHtml(String(h.action || '').replace(/_/g, ' '))}${extra}</div>
        <div class="admin-timeline-item__meta">${fmtDateTime(h.at)} · ${h.actorType}${h.actorId ? ' (' + escapeHtml(h.actorId) + ')' : ''}</div>
      </div>`;
    })
    .join('')}</div>`;
}

/* ---------------------------------------------------------------------
   Load
--------------------------------------------------------------------- */

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
  document.querySelector('[data-delivery-method]').textContent = destinationLabel(order);

  const addrEl = document.querySelector('[data-delivery-address]');
  if (order.deliveryAddress) {
    const a = order.deliveryAddress;
    // `barangay` is absent on pre-5D.2 orders — filtered out rather than
    // rendered as an empty line.
    const lines = [a.line1, a.line2, a.barangay, a.city, a.province, a.postalCode].filter(Boolean).map(escapeHtml);
    const regionLine =
      order.deliveryMethod === 'delivery'
        ? `<div style="margin-top:8px;"><span class="admin-kv__k">Region</span><div class="admin-kv__v${order.destinationRegion ? '' : ' is-muted'}" style="font-size:13.5px;">${
            order.destinationRegion ? escapeHtml(destinationLabel(order)) : 'Not recorded'
          }</div></div>`
        : '';
    addrEl.innerHTML = lines.join('<br>') + regionLine;
  } else {
    addrEl.innerHTML = '<span class="hint">No address on file — pickup order.</span>';
  }

  renderLines();

  // Always the order's own stored snapshot — never recomputed from today's
  // shipping settings.
  document.querySelector('[data-detail-subtotal]').textContent = fmtMoney(order.pricing.subtotal);
  document.querySelector('[data-detail-shipping-label]').textContent =
    order.deliveryMethod === 'pickup' ? 'Shipping — Pickup' : 'Shipping — ' + destinationLabel(order);
  document.querySelector('[data-detail-shipping]').textContent = order.pricing.shippingFee > 0 ? fmtMoney(order.pricing.shippingFee) : 'Free';
  document.querySelector('[data-detail-total]').textContent = fmtMoney(order.pricing.total);

  applyBadge('[data-payment-status-badge]', PAYMENT_STATUS, order.paymentStatus);
  applyBadge('[data-fulfillment-status-badge]', FULFILLMENT_STATUS, order.fulfillmentStatus);
  applyBadge('[data-inventory-status-badge]', INVENTORY_STATUS, order.inventoryStatus, order.inventoryStatus ? undefined : 'N/A');

  renderPaymentBanner();
  renderPaymentExpected();
  renderPaymentCurrent();
  renderPaymentActions();
  renderPaymentAttempts();

  renderFulfillmentBanner();
  renderFulfillmentSteps();
  renderShipmentDetails();
  renderFulfillmentActions();

  renderHistory();
}

async function init() {
  await requireSession();
  await renderAdminShell('orders');
  await load();
}

init();
