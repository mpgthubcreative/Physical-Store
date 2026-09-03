import { requireSession, apiFetch } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { PAYMENT_STATUS, FULFILLMENT_STATUS, statusBadge, destinationShort, fmtMoney, fmtDate, escapeHtml } from './admin-format.js';

function setKpi(selector, value) {
  const el = document.querySelector(selector);
  el.textContent = value;
  el.classList.remove('is-loading');
}

/**
 * Operational queues — the first thing the Owner should see. Each card is a
 * link into the Orders page pre-filtered to exactly that queue, so "3
 * payments to review" is one click from the review screen.
 *
 * A queue with nothing in it still renders (dimmed, count 0) rather than
 * disappearing — a missing card reads as "something is broken", while a
 * visible zero reads as "nothing to do", which is the actual message.
 */
function renderOperationalQueues({ pendingReviewCount, paidUnfulfilledCount }) {
  const queues = [
    {
      count: pendingReviewCount,
      title: 'Payments to Review',
      desc: pendingReviewCount === 1 ? '1 payment submitted and awaiting your decision' : `${pendingReviewCount} payments submitted and awaiting your decision`,
      href: 'orders.html?paymentStatus=pending_review',
      cta: 'Review payments →',
    },
    {
      count: paidUnfulfilledCount,
      title: 'Orders to Fulfill',
      desc: paidUnfulfilledCount === 1 ? '1 paid order not yet started' : `${paidUnfulfilledCount} paid orders not yet started`,
      href: 'orders.html?paymentStatus=paid&fulfillmentStatus=unfulfilled',
      cta: 'Start fulfilling →',
    },
  ];

  document.querySelector('[data-operational-queues]').innerHTML = queues
    .map(
      (q) => `
      <a class="admin-queue-card ${q.count > 0 ? 'is-attention' : 'is-clear'}" href="${q.href}">
        <div class="admin-queue-card__count">${q.count}</div>
        <div class="admin-queue-card__body">
          <div class="admin-queue-card__title">${q.title}</div>
          <div class="admin-queue-card__desc">${q.count > 0 ? escapeHtml(q.desc) : 'Nothing waiting right now'}</div>
          ${q.count > 0 ? `<div class="admin-queue-card__cta">${q.cta}</div>` : ''}
        </div>
      </a>`
    )
    .join('');
}

function renderRecentOrders(orders) {
  const tbody = document.querySelector('[data-recent-orders]');
  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="admin-empty">No orders yet.</td></tr>';
    return;
  }
  tbody.innerHTML = orders
    .map(
      (o) => `
    <tr>
      <td data-role="heading"><span class="admin-row-title">${o.orderNumber}</span>${o.isTest ? ' <span class="admin-badge admin-badge--neutral">TEST</span>' : ''}</td>
      <td data-role="meta" data-label="Customer">${escapeHtml(o.customerName)}</td>
      <td data-role="meta" data-label="Destination">${destinationShort(o)}</td>
      <td data-role="meta" data-label="Total">${fmtMoney(o.total)}</td>
      <td data-role="meta" data-label="Payment">${statusBadge(PAYMENT_STATUS, o.paymentStatus)}</td>
      <td data-role="meta" data-label="Fulfillment">${statusBadge(FULFILLMENT_STATUS, o.fulfillmentStatus)}</td>
      <td data-role="meta" data-label="Date">${fmtDate(o.createdAt)}</td>
      <td data-role="actions"><a class="admin-btn admin-btn--ghost admin-btn--small" href="order-detail.html?id=${o.orderId}">View</a></td>
    </tr>`
    )
    .join('');
}

/** Stock-only attention now — the order queues moved up into their own cards. */
function renderAttention({ lowStockProducts }) {
  const card = document.querySelector('[data-attention-card]');
  if (!lowStockProducts.length) {
    card.innerHTML = `
      <div class="admin-empty-state" style="padding:20px 0;">
        <div class="admin-empty-state__title">Stock looks fine</div>
        <div class="admin-empty-state__desc">No active product is out of stock.</div>
      </div>`;
    return;
  }
  card.innerHTML = `<div class="admin-timeline">
    <div class="admin-timeline-item">
      <div class="admin-timeline-item__action">${lowStockProducts.length} product${lowStockProducts.length === 1 ? ' is' : 's are'} out of stock</div>
      <div class="admin-timeline-item__meta">${lowStockProducts.map((p) => escapeHtml(p.title)).join(', ')}</div>
    </div>
  </div>`;
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

    renderOperationalQueues({
      pendingReviewCount: orderStats.pendingReviewCount,
      // Falls back to the combined counter if an older deploy of
      // admin-order-stats.js is still live.
      paidUnfulfilledCount: orderStats.paidUnfulfilledCount ?? orderStats.paidAwaitingProcessingCount,
    });

    setKpi('[data-count-total-orders]', orderStats.totalOrdersCount);

    const activeProducts = products.filter((p) => p.active);
    setKpi('[data-count-products]', activeProducts.length);
    document.querySelector('[data-count-products-sub]').textContent = `${products.length} total`;
    setKpi('[data-count-patches]', patches.length);
    setKpi('[data-count-collections]', collections.length);

    const lowStockProducts = products.filter((p) => p.active && p.totalStock === 0);
    setKpi('[data-count-lowstock]', lowStockProducts.length);

    renderRecentOrders(recentOrders);
    renderAttention({ lowStockProducts });
  } catch (err) {
    console.error(err);
  }
}

init();
