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

export function statusBadge(map, key, fallbackLabel) {
  const entry = map[key] || { label: fallbackLabel || key || '—', tone: 'neutral' };
  return `<span class="admin-badge admin-badge--${entry.tone}">${entry.label}</span>`;
}

export function tone(map, key) {
  return (map[key] || {}).tone || 'neutral';
}

export function fmtMoney(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH') + '.00';
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
