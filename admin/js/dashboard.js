import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { PAYMENT_STATUS, FULFILLMENT_STATUS, statusBadge, fmtMoney, fmtDate, escapeHtml } from './admin-format.js';

function setKpi(selector, value) {
  const el = document.querySelector(selector);
  el.textContent = value;
  el.classList.remove('is-loading');
}

function renderRecentOrders(orders) {
  const tbody = document.querySelector('[data-recent-orders]');
  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">No orders yet.</td></tr>';
    return;
  }
  tbody.innerHTML = orders
    .map(
      (o) => `
    <tr>
      <td data-role="heading"><span class="admin-row-title">${o.orderNumber}</span>${o.isTest ? ' <span class="admin-badge admin-badge--neutral">TEST</span>' : ''}</td>
      <td data-role="meta" data-label="Customer">${escapeHtml(o.customerName)}</td>
      <td data-role="meta" data-label="Total">${fmtMoney(o.total)}</td>
      <td data-role="meta" data-label="Payment">${statusBadge(PAYMENT_STATUS, o.paymentStatus)}</td>
      <td data-role="meta" data-label="Fulfillment">${statusBadge(FULFILLMENT_STATUS, o.fulfillmentStatus)}</td>
      <td data-role="meta" data-label="Date">${fmtDate(o.createdAt)}</td>
      <td data-role="actions"><a class="admin-btn admin-btn--ghost admin-btn--small" href="order-detail.html?id=${o.orderId}">View</a></td>
    </tr>`
    )
    .join('');
}

function renderAttention({ pendingReviewCount, paidAwaitingProcessingCount, lowStockProducts }) {
  const card = document.querySelector('[data-attention-card]');
  const items = [];

  if (pendingReviewCount > 0) {
    items.push(`
      <div class="admin-timeline-item">
        <div class="admin-timeline-item__action">${pendingReviewCount} payment${pendingReviewCount === 1 ? '' : 's'} awaiting review</div>
        <div class="admin-timeline-item__meta"><a href="orders.html?paymentStatus=pending_review">Review now →</a></div>
      </div>`);
  }
  if (paidAwaitingProcessingCount > 0) {
    items.push(`
      <div class="admin-timeline-item">
        <div class="admin-timeline-item__action">${paidAwaitingProcessingCount} paid order${paidAwaitingProcessingCount === 1 ? '' : 's'} awaiting processing</div>
        <div class="admin-timeline-item__meta"><a href="orders.html?paymentStatus=paid">View orders →</a></div>
      </div>`);
  }
  if (lowStockProducts.length) {
    items.push(`
      <div class="admin-timeline-item">
        <div class="admin-timeline-item__action">${lowStockProducts.length} product${lowStockProducts.length === 1 ? ' is' : 's are'} out of stock</div>
        <div class="admin-timeline-item__meta">${lowStockProducts.map((p) => escapeHtml(p.title)).join(', ')}</div>
      </div>`);
  }

  if (!items.length) {
    card.innerHTML = `
      <div class="admin-empty-state" style="padding:20px 0;">
        <div class="admin-empty-state__title">All clear</div>
        <div class="admin-empty-state__desc">Nothing needs your attention right now.</div>
      </div>`;
    return;
  }
  card.innerHTML = `<div class="admin-timeline">${items.join('')}</div>`;
}

async function init() {
  await requireSession();
  await renderAdminShell('dashboard');

  try {
    const [{ products }, { patches }, { collections }, orderStats, { orders: recentOrders }] = await Promise.all([
      apiFetch('/api/admin-list-products'),
      apiFetch('/api/admin-list-patches'),
      apiFetch('/api/admin-list-collections'),
      apiFetch('/api/admin-order-stats'),
      apiFetch('/api/admin-list-orders?limit=5'),
    ]);

    setKpi('[data-count-pending-review]', orderStats.pendingReviewCount);
    setKpi('[data-count-paid-awaiting]', orderStats.paidAwaitingProcessingCount);
    setKpi('[data-count-total-orders]', orderStats.totalOrdersCount);

    const activeProducts = products.filter((p) => p.active);
    setKpi('[data-count-products]', activeProducts.length);
    document.querySelector('[data-count-products-sub]').textContent = `${products.length} total`;
    setKpi('[data-count-patches]', patches.length);
    setKpi('[data-count-collections]', collections.length);

    const lowStockProducts = products.filter((p) => p.active && p.totalStock === 0);
    setKpi('[data-count-lowstock]', lowStockProducts.length);

    renderRecentOrders(recentOrders);
    renderAttention({
      pendingReviewCount: orderStats.pendingReviewCount,
      paidAwaitingProcessingCount: orderStats.paidAwaitingProcessingCount,
      lowStockProducts,
    });
  } catch (err) {
    console.error(err);
  }
}

init();
