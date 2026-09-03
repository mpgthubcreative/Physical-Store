import { requireSession, apiFetch, getIdToken } from './admin-auth.js';
import { renderAdminShell } from './admin-shell.js';
import { PAYMENT_STATUS, FULFILLMENT_STATUS, statusBadge, destinationShort, fmtMoney, fmtDate, escapeHtml } from './admin-format.js';
import { showToast, setButtonBusy } from './admin-ui.js';

/*
 * Admin Dashboard.
 *
 * Two clearly separated halves:
 *
 *   1. LIVE OPERATIONAL QUEUES (Payments to Review / Orders to Fulfill).
 *      These come from admin-order-stats.js and always describe the CURRENT
 *      state of the store. They are deliberately NOT filtered by the report
 *      date range — "3 payments waiting" must mean 3 payments waiting now,
 *      not 3 payments that were waiting during some historical window.
 *
 *   2. REPORTING (everything below the Reports divider). Driven entirely by
 *      admin-report.js against the selected Asia/Manila date range.
 *
 * The date range is resolved SERVER-SIDE. This module only ever sends a
 * preset name or two YYYY-MM-DD strings — never a timestamp and never a
 * browser-derived notion of "today", so an admin working from a laptop set
 * to another timezone still gets Philippine business days.
 *
 * Test orders are excluded by default; the toggle is opt-in and resets to
 * off on every page load.
 */

const $ = (sel) => document.querySelector(sel);

let reportState = {
  preset: 'today',
  startDate: null,
  endDate: null,
  includeTest: false,
};
let lastReport = null;

/* ---------------------------------------------------------------------
   Live operational queues (never date-filtered)
--------------------------------------------------------------------- */

function renderOperationalQueues({ pendingReviewCount, paidUnfulfilledCount }) {
  const queues = [
    {
      count: pendingReviewCount,
      title: 'Payments to Review',
      desc: pendingReviewCount === 1 ? '1 payment awaiting your decision' : `${pendingReviewCount} payments awaiting your decision`,
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

  $('[data-operational-queues]').innerHTML = queues
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

/* ---------------------------------------------------------------------
   Reporting
--------------------------------------------------------------------- */

function kpi(label, value, sub) {
  return `
    <div class="admin-kpi">
      <div class="admin-kpi__top"><span class="admin-kpi__label">${escapeHtml(label)}</span></div>
      <div class="admin-kpi__value">${escapeHtml(String(value))}</div>
      ${sub ? `<div class="admin-kpi__sub">${escapeHtml(sub)}</div>` : ''}
    </div>`;
}

function renderMetrics(report) {
  const s = report.summary;

  $('[data-metrics-orders]').innerHTML = [
    kpi('Total Orders', s.totalOrders),
    kpi('Paid Orders', s.paidOrders),
    kpi('Awaiting Payment', s.awaitingPayment),
    kpi('Pending Review', s.pendingReview),
    kpi('Rejected', s.rejected),
  ].join('');

  $('[data-metrics-sales]').innerHTML = [
    kpi('Gross Paid Sales', fmtMoney(s.grossPaidSales), 'Paid orders only'),
    kpi('Merchandise Sales', fmtMoney(s.merchandiseSales), 'Items subtotal'),
    kpi('Shipping Collected', fmtMoney(s.shippingCollected), 'Shipping fees'),
    kpi('Average Paid Order', fmtMoney(s.averagePaidOrderValue), s.paidOrders ? `Across ${s.paidOrders} paid` : 'No paid orders'),
  ].join('');

  const f = s.fulfillmentBreakdown;
  $('[data-metrics-fulfillment]').innerHTML = [
    kpi('Unfulfilled', f.unfulfilled),
    kpi('Processing', f.processing),
    kpi('Ready for Pickup', f.ready_for_pickup),
    kpi('Shipped', f.shipped),
    kpi('Completed', f.completed),
  ].join('');
}

function renderReportRows(report) {
  const tbody = $('[data-report-rows]');
  if (!report.orders.length) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div class="admin-empty-state">
          <div class="admin-empty-state__title">No orders in this date range</div>
          <div class="admin-empty-state__desc">Try a different range${report.includeTest ? '' : ', or include TEST orders'}.</div>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = report.orders
    .map(
      (o) => `
    <tr data-order-id="${escapeHtml(o.orderId)}" style="cursor:pointer;">
      <td data-role="heading">
        <span class="admin-row-title">${escapeHtml(o.orderNumber)}</span>${o.isTest ? ' <span class="admin-badge admin-badge--neutral">TEST</span>' : ''}
      </td>
      <td data-role="meta" data-label="Date">${escapeHtml(o.orderDate)}</td>
      <td data-role="meta" data-label="Customer">
        <div>${escapeHtml(o.customerName)}<div class="admin-row-sub">${escapeHtml(o.customerEmail)}</div></div>
      </td>
      <td data-role="meta" data-label="Destination">${destinationShort(o)}</td>
      <td data-role="meta" data-label="Subtotal">${fmtMoney(o.subtotal)}</td>
      <td data-role="meta" data-label="Shipping">${o.shippingFee > 0 ? fmtMoney(o.shippingFee) : 'Free'}</td>
      <td data-role="meta" data-label="Total"><strong>${fmtMoney(o.total)}</strong></td>
      <td data-role="meta" data-label="Payment">${statusBadge(PAYMENT_STATUS, o.paymentStatus)}</td>
      <td data-role="meta" data-label="Fulfillment">${statusBadge(FULFILLMENT_STATUS, o.fulfillmentStatus)}</td>
    </tr>`
    )
    .join('');

  tbody.querySelectorAll('[data-order-id]').forEach((row) => {
    row.addEventListener('click', () => {
      window.location.href = 'order-detail.html?id=' + encodeURIComponent(row.dataset.orderId);
    });
  });
}

function renderReportNote(report) {
  const note = $('[data-report-note]');
  const parts = [];

  if (!report.includeTest && report.meta.testOrdersInRange > 0) {
    const n = report.meta.testOrdersInRange;
    parts.push(`${n} TEST order${n === 1 ? '' : 's'} hidden from these figures.`);
  }
  if (report.includeTest) {
    parts.push('TEST orders are INCLUDED — these figures are not clean revenue numbers.');
  }
  if (report.meta.truncated) {
    parts.push(`Only the most recent ${report.meta.maxOrders} orders are included. Narrow the date range for a complete report.`);
  }

  if (!parts.length) {
    note.hidden = true;
    return;
  }
  note.hidden = false;
  note.textContent = parts.join(' ');
  note.className = 'admin-report-note' + (report.includeTest || report.meta.truncated ? ' is-warning' : '');
}

/** The query string shared by the report view and both exports — one builder, so they cannot diverge. */
function reportQuery() {
  const params = new URLSearchParams();
  params.set('preset', reportState.preset);
  if (reportState.preset === 'custom') {
    params.set('startDate', reportState.startDate || '');
    params.set('endDate', reportState.endDate || '');
  }
  if (reportState.includeTest) params.set('includeTest', 'true');
  return params.toString();
}

async function loadReport() {
  const loading = $('[data-report-loading]');
  const metrics = $('[data-report-metrics]');
  loading.hidden = false;
  metrics.hidden = true;

  try {
    const report = await apiFetch('/api/admin-report?' + reportQuery());
    lastReport = report;

    $('[data-report-range-label]').textContent = report.range.label;
    renderMetrics(report);
    renderReportRows(report);
    renderReportNote(report);

    loading.hidden = true;
    metrics.hidden = false;
  } catch (err) {
    loading.hidden = true;
    const note = $('[data-report-note]');
    note.hidden = false;
    note.className = 'admin-report-note is-error';
    note.textContent = err.message;
  }
}

/* ---------------------------------------------------------------------
   Export
--------------------------------------------------------------------- */

/**
 * Downloads an export.
 *
 * A plain <a href> can't be used: the endpoint requires an Authorization
 * header. So the file is fetched as a blob and handed to a temporary object
 * URL. The query string is built by the SAME reportQuery() the on-screen
 * report used, so the export can never describe a different dataset.
 */
async function downloadExport(format, btn) {
  setButtonBusy(btn, true, 'Preparing…');
  try {
    const token = await getIdToken();
    const res = await fetch(`/api/admin-report-export?format=${format}&` + reportQuery(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      let message = `Export failed (${res.status}).`;
      try {
        const body = await res.json();
        if (body && body.error) message = body.error;
      } catch (e) {
        /* non-JSON error body */
      }
      throw new Error(message);
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match ? match[1] : `Buddy-Patches-Report.${format}`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the download has certainly started.
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showToast(`${format === 'xlsx' ? 'Excel' : 'PDF'} report downloaded.`, 'success');
  } catch (err) {
    showToast(err.message || 'Export failed.', 'error');
  } finally {
    setButtonBusy(btn, false);
    $('[data-download-list]').hidden = true;
    $('[data-download-toggle]').setAttribute('aria-expanded', 'false');
  }
}

/* ---------------------------------------------------------------------
   Controls
--------------------------------------------------------------------- */

function initReportControls() {
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('is-active', b === btn));
      $('[data-custom-range]').hidden = preset !== 'custom';

      if (preset === 'custom') {
        // Don't fire a request until Apply — an empty From/To would just error.
        if (!$('[data-report-from]').value || !$('[data-report-to]').value) return;
        reportState.preset = 'custom';
        reportState.startDate = $('[data-report-from]').value;
        reportState.endDate = $('[data-report-to]').value;
      } else {
        reportState.preset = preset;
        reportState.startDate = null;
        reportState.endDate = null;
      }
      loadReport();
    });
  });

  $('[data-apply-range]').addEventListener('click', () => {
    const from = $('[data-report-from]').value;
    const to = $('[data-report-to]').value;
    if (!from || !to) {
      showToast('Please choose both a From and a To date.', 'error');
      return;
    }
    // The server validates this too; catching it here just avoids a
    // pointless round trip and gives a faster message.
    if (from > to) {
      showToast('The "To" date must be on or after the "From" date.', 'error');
      return;
    }
    reportState = { ...reportState, preset: 'custom', startDate: from, endDate: to };
    loadReport();
  });

  $('[data-include-test]').addEventListener('change', (e) => {
    reportState.includeTest = e.target.checked;
    loadReport();
  });

  const toggle = $('[data-download-toggle]');
  const list = $('[data-download-list]');
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = list.hidden;
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', () => {
    if (!list.hidden) {
      list.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
  list.addEventListener('click', (e) => e.stopPropagation());
  list.querySelectorAll('[data-export]').forEach((btn) => {
    btn.addEventListener('click', () => downloadExport(btn.dataset.export, btn));
  });
}

/* ---------------------------------------------------------------------
   Catalog "at a glance" + stock attention
--------------------------------------------------------------------- */

function setKpi(selector, value) {
  const el = document.querySelector(selector);
  el.textContent = value;
  el.classList.remove('is-loading');
}

function renderAttention({ lowStockProducts }) {
  const card = $('[data-attention-card]');
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

function renderRecentOrders(orders) {
  const tbody = $('[data-recent-orders]');
  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="admin-empty">No orders yet.</td></tr>';
    return;
  }
  tbody.innerHTML = orders
    .map(
      (o) => `
    <tr>
      <td data-role="heading"><span class="admin-row-title">${escapeHtml(o.orderNumber)}</span>${o.isTest ? ' <span class="admin-badge admin-badge--neutral">TEST</span>' : ''}</td>
      <td data-role="meta" data-label="Customer">${escapeHtml(o.customerName)}</td>
      <td data-role="meta" data-label="Destination">${destinationShort(o)}</td>
      <td data-role="meta" data-label="Total">${fmtMoney(o.total)}</td>
      <td data-role="meta" data-label="Payment">${statusBadge(PAYMENT_STATUS, o.paymentStatus)}</td>
      <td data-role="meta" data-label="Fulfillment">${statusBadge(FULFILLMENT_STATUS, o.fulfillmentStatus)}</td>
      <td data-role="meta" data-label="Date">${fmtDate(o.createdAt)}</td>
      <td data-role="actions"><a class="admin-btn admin-btn--ghost admin-btn--small" href="order-detail.html?id=${encodeURIComponent(o.orderId)}">View</a></td>
    </tr>`
    )
    .join('');
}

/* ---------------------------------------------------------------------
   Boot
--------------------------------------------------------------------- */

async function init() {
  await requireSession();
  await renderAdminShell('dashboard');

  initReportControls();

  // The report is the primary content, so it loads first and independently
  // of the slower catalog aggregate calls below.
  loadReport();

  try {
    const orderStats = await apiFetch('/api/admin-order-stats');
    renderOperationalQueues({
      pendingReviewCount: orderStats.pendingReviewCount,
      paidUnfulfilledCount: orderStats.paidUnfulfilledCount ?? orderStats.paidAwaitingProcessingCount,
    });
    setKpi('[data-count-total-orders]', orderStats.totalOrdersCount);
  } catch (err) {
    console.error('Order stats failed:', err);
  }

  try {
    const [{ products }, { patches }, { collections }, { orders: recentOrders }] = await Promise.all([
      apiFetch('/api/admin-list-products'),
      apiFetch('/api/admin-list-patches'),
      apiFetch('/api/admin-list-collections'),
      apiFetch('/api/admin-list-orders?limit=5'),
    ]);

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
    console.error('Catalog summary failed:', err);
  }
}

init();
