/**
 * Shared status→label/tone maps and formatters — one definition of what
 * "pending_review" is called and what color it gets, reused by the
 * dashboard, orders list, and order detail instead of three copies.
 */

export const PAYMENT_STATUS = {
  awaiting_payment: { label: 'Awaiting payment', tone: 'neutral' },
  pending_review: { label: 'Pending review', tone: 'warning' },
  paid: { label: 'Paid', tone: 'positive' },
  rejected: { label: 'Rejected', tone: 'danger' },
};

export const FULFILLMENT_STATUS = {
  unfulfilled: { label: 'Unfulfilled', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'warning' },
  ready_for_pickup: { label: 'Ready for pickup', tone: 'info' },
  shipped: { label: 'Shipped', tone: 'info' },
  completed: { label: 'Completed', tone: 'positive' },
};

export const INVENTORY_STATUS = {
  reserved: { label: 'Reserved', tone: 'warning' },
  locked: { label: 'Locked', tone: 'info' },
  consumed: { label: 'Consumed', tone: 'positive' },
  expired: { label: 'Expired', tone: 'danger' },
};

export const REGION_LABELS = { luzon: 'Luzon', visayas: 'Visayas', mindanao: 'Mindanao' };

/**
 * One definition of how an order's destination reads in the UI, used by the
 * Orders table and Order Detail alike.
 *
 * Orders created before Phase 5D.2 have no destinationRegion at all. A
 * delivery order in that state shows "Not recorded" rather than a blank or
 * a guess — the region was genuinely never captured for it, and nothing
 * backfills historical orders to pretend otherwise.
 */
export function destinationLabel(order) {
  if (order.deliveryMethod === 'pickup') return 'Pickup';
  const region = order.destinationRegion;
  if (!region) return 'Delivery — region not recorded';
  return REGION_LABELS[region] || region;
}

/**
 * Short form for the Orders table column.
 *
 * Returns HTML (the "not recorded" case carries a span), so callers insert
 * it with innerHTML — which means the region fallback must be escaped. The
 * value is a server-validated enum today; escaping keeps that from being a
 * load-bearing assumption if a future writer ever widens it.
 */
export function destinationShort(order) {
  if (order.deliveryMethod === 'pickup') return 'Pickup';
  const region = order.destinationRegion;
  if (!region) return 'Delivery <span class="admin-row-sub" style="display:inline;">(not recorded)</span>';
  return REGION_LABELS[region] || escapeHtml(region);
}

export function statusBadge(map, key, fallbackLabel) {
  const entry = map[key] || { label: fallbackLabel || key || '—', tone: 'neutral' };
  return `<span class="admin-badge admin-badge--${entry.tone}">${entry.label}</span>`;
}

export function tone(map, key) {
  return (map[key] || {}).tone || 'neutral';
}

/**
 * Peso formatting.
 *
 * This used to be `toLocaleString('en-PH') + '.00'`, which only worked
 * because every value was a whole number: order totals, subtotals and
 * shipping fees are all integers. Phase 5D.3 introduced the first
 * FRACTIONAL money value — average paid order value — and the old version
 * rendered it as "₱11,455.125.00", appending .00 to a number that already
 * had decimals. It also disagreed with the Excel/PDF exports, which format
 * to exactly two decimals, so the same figure printed differently in the
 * dashboard and in the report generated from it.
 *
 * Formatting the fraction digits properly fixes both, and is unchanged for
 * the integer values everywhere else (1130 -> "₱1,130.00").
 */
export function fmtMoney(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(v) {
  if (!v) return '—';
  const d = v._seconds ? new Date(v._seconds * 1000) : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(v) {
  if (!v) return '—';
  const d = v._seconds ? new Date(v._seconds * 1000) : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
