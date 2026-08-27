import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';

let orders = [];
let nextCursor = null;

const PAYMENT_LABELS = { awaiting_payment: 'Awaiting payment', pending_review: 'Pending review', paid: 'Paid', rejected: 'Rejected' };
const PAYMENT_BADGE = { awaiting_payment: 'admin-badge--inactive', pending_review: 'admin-badge--low', paid: 'admin-badge--active', rejected: 'admin-badge--inactive' };
const FULFILLMENT_LABELS = {
  unfulfilled: 'Unfulfilled',
  processing: 'Processing',
  ready_for_pickup: 'Ready for pickup',
  shipped: 'Shipped',
  completed: 'Completed',
};

function fmtDate(v) {
  if (!v) return '—';
  const d = v._seconds ? new Date(v._seconds * 1000) : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtMoney(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH') + '.00';
}

function renderRows() {
  const tbody = document.querySelector('[data-order-rows]');
  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">No orders yet.</td></tr>';
    return;
  }
  tbody.innerHTML = orders
    .map(
      (o) => `
    <tr data-order-id="${o.orderId}" style="cursor:pointer;">
      <td>${o.orderNumber}${o.isTest ? ' <span class="admin-badge admin-badge--low">TEST</span>' : ''}</td>
      <td>${o.customerName}<br><span class="hint">${o.customerEmail}</span></td>
      <td>${fmtDate(o.createdAt)}</td>
      <td>${fmtMoney(o.total)}</td>
      <td><span class="admin-badge ${PAYMENT_BADGE[o.paymentStatus] || ''}">${PAYMENT_LABELS[o.paymentStatus] || o.paymentStatus}</span></td>
      <td>${FULFILLMENT_LABELS[o.fulfillmentStatus] || o.fulfillmentStatus}</td>
      <td><a class="admin-btn admin-btn--ghost admin-btn--small" href="order-detail.html?id=${o.orderId}">View</a></td>
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
  await loadOrders(true);
}

init();
