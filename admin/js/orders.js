import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { PAYMENT_STATUS, FULFILLMENT_STATUS, statusBadge, fmtMoney, fmtDate, escapeHtml } from './admin-format.js';

let orders = [];
let nextCursor = null;

function renderRows() {
  const tbody = document.querySelector('[data-order-rows]');
  if (!orders.length) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="admin-empty-state">
          <div class="admin-empty-state__title">No orders match these filters</div>
          <div class="admin-empty-state__desc">Try a different payment or fulfillment status, or clear the filters.</div>
        </div>
      </td></tr>`;
    return;
  }
  tbody.innerHTML = orders
    .map(
      (o) => `
    <tr data-order-id="${o.orderId}" style="cursor:pointer;">
      <td data-role="heading"><span class="admin-row-title">${o.orderNumber}</span>${o.isTest ? ' <span class="admin-badge admin-badge--neutral">TEST</span>' : ''}</td>
      <td data-role="meta" data-label="Customer">
        <div>
          ${escapeHtml(o.customerName)}
          <div class="admin-row-sub">${escapeHtml(o.customerEmail)}</div>
        </div>
      </td>
      <td data-role="meta" data-label="Date">${fmtDate(o.createdAt)}</td>
      <td data-role="meta" data-label="Total">${fmtMoney(o.total)}</td>
      <td data-role="meta" data-label="Payment">${statusBadge(PAYMENT_STATUS, o.paymentStatus)}</td>
      <td data-role="meta" data-label="Fulfillment">${statusBadge(FULFILLMENT_STATUS, o.fulfillmentStatus)}</td>
      <td data-role="actions"><a class="admin-btn admin-btn--ghost admin-btn--small" href="order-detail.html?id=${o.orderId}">View</a></td>
    </tr>`
    )
    .join('');

  tbody.querySelectorAll('[data-order-id]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // let the explicit "View" link navigate itself
      window.location.href = 'order-detail.html?id=' + row.dataset.orderId;
    });
  });
}

async function loadOrders(reset) {
  if (reset) {
    orders = [];
    nextCursor = null;
    document.querySelector('[data-order-rows]').innerHTML = '<tr><td colspan="7" class="admin-empty">Loading…</td></tr>';
  }
  const params = new URLSearchParams();
  params.set('limit', '20');
  if (nextCursor) params.set('cursor', nextCursor);
  const paymentStatus = document.querySelector('[data-filter-payment]').value;
  const fulfillmentStatus = document.querySelector('[data-filter-fulfillment]').value;
  if (paymentStatus) params.set('paymentStatus', paymentStatus);
  if (fulfillmentStatus) params.set('fulfillmentStatus', fulfillmentStatus);

  const data = await apiFetch('/api/admin-list-orders?' + params.toString());
  orders = orders.concat(data.orders);
  nextCursor = data.nextCursor;
  renderRows();
  document.querySelector('[data-load-more]').hidden = !nextCursor;
}

document.querySelector('[data-filter-payment]').addEventListener('change', () => loadOrders(true));
document.querySelector('[data-filter-fulfillment]').addEventListener('change', () => loadOrders(true));
document.querySelector('[data-load-more]').addEventListener('click', () => loadOrders(false));

async function init() {
  await requireSession();
  await renderAdminShell('orders');

  // Pre-select a filter when arriving from a dashboard "Attention needed" link.
  const params = new URLSearchParams(location.search);
  const paymentStatus = params.get('paymentStatus');
  if (paymentStatus) document.querySelector('[data-filter-payment]').value = paymentStatus;

  await loadOrders(true);
}

init();
