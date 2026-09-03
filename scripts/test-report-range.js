/*
 * OFFLINE TEST — Asia/Manila reporting boundaries and aggregation rules.
 * No credentials, no network, no Firestore.
 *
 * The late-night cases are the point of this file: an order placed at
 * 12:30am Manila must land in the correct Manila day, not the previous UTC
 * day.
 *
 * Usage: node scripts/test-report-range.js
 */
const assert = require('assert');
const { resolveRange, manilaParts, manilaDateTime, parseDateString } = require('../netlify/functions/_shared/reportRange');
const { buildSummary, derivePaymentMethod, destinationLabel } = require('../netlify/functions/_shared/reportData');
const { ValidationError } = require('../netlify/functions/_shared/validation');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    console.error('  FAIL  ' + name + '\n        ' + err.message);
    process.exitCode = 1;
  }
}
function throwsValidation(fn) {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return;
    throw new Error('threw ' + err.name + ' instead of ValidationError');
  }
  throw new Error('expected a ValidationError, nothing thrown');
}

/** A UTC instant for a given Manila wall-clock moment. */
const manila = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - 8 * 3600 * 1000;

console.log('\n=== Manila civil date derivation ===');

test('11:30pm Manila Sep 3 is still Sep 3 in Manila (15:30 UTC)', () => {
  const p = manilaParts(manila(2026, 9, 3, 23, 30));
  assert.deepStrictEqual([p.year, p.month, p.day], [2026, 9, 3]);
});

test('12:30am Manila Sep 4 is Sep 4 in Manila, though it is Sep 3 in UTC', () => {
  const utcMs = manila(2026, 9, 4, 0, 30);
  assert.strictEqual(new Date(utcMs).getUTCDate(), 3, 'sanity: it really is the 3rd in UTC');
  const p = manilaParts(utcMs);
  assert.deepStrictEqual([p.year, p.month, p.day], [2026, 9, 4], 'must report Sep 4 in Manila');
});

test('exactly midnight Manila belongs to the new day', () => {
  const p = manilaParts(manila(2026, 9, 4, 0, 0));
  assert.deepStrictEqual([p.year, p.month, p.day], [2026, 9, 4]);
});

console.log('\n=== preset: today ===');

test('today spans exactly one Manila day', () => {
  const r = resolveRange({ preset: 'today', nowMs: manila(2026, 9, 3, 13, 41) });
  assert.strictEqual(r.startDate, '2026-09-03');
  assert.strictEqual(r.endDate, '2026-09-03');
  assert.strictEqual(r.startUtcMs, manila(2026, 9, 3, 0, 0));
  assert.strictEqual(r.endUtcMs, manila(2026, 9, 4, 0, 0));
  assert.strictEqual(r.spanDays, 1);
});

test('an order at 12:30am Manila falls INSIDE that Manila day', () => {
  const r = resolveRange({ preset: 'today', nowMs: manila(2026, 9, 4, 9, 0) });
  const orderMs = manila(2026, 9, 4, 0, 30);
  assert.ok(orderMs >= r.startUtcMs && orderMs < r.endUtcMs, 'late-night order must be inside today');
});

test('an order at 11:59pm Manila the previous day is EXCLUDED from today', () => {
  const r = resolveRange({ preset: 'today', nowMs: manila(2026, 9, 4, 9, 0) });
  const orderMs = manila(2026, 9, 3, 23, 59);
  assert.ok(orderMs < r.startUtcMs, 'previous evening must not leak into today');
});

test('an order at 11:59pm Manila today is INCLUDED', () => {
  const r = resolveRange({ preset: 'today', nowMs: manila(2026, 9, 3, 9, 0) });
  assert.ok(manila(2026, 9, 3, 23, 59) < r.endUtcMs);
});

console.log('\n=== preset: week (Monday–Sunday) ===');

// 2026-09-03 is a Thursday.
test('mid-week Thursday starts the range on Monday', () => {
  const r = resolveRange({ preset: 'week', nowMs: manila(2026, 9, 3, 12, 0) });
  assert.strictEqual(r.startDate, '2026-08-31', 'Monday of that week');
  assert.strictEqual(r.endDate, '2026-09-03');
});

test('Monday itself starts the range on that same Monday', () => {
  const r = resolveRange({ preset: 'week', nowMs: manila(2026, 8, 31, 12, 0) });
  assert.strictEqual(r.startDate, '2026-08-31');
  assert.strictEqual(r.endDate, '2026-08-31');
});

test('Sunday looks back six days, not zero (the classic off-by-one)', () => {
  // 2026-09-06 is a Sunday.
  const r = resolveRange({ preset: 'week', nowMs: manila(2026, 9, 6, 12, 0) });
  assert.strictEqual(r.startDate, '2026-08-31', 'Sunday belongs to the week that began Monday Aug 31');
  assert.strictEqual(r.endDate, '2026-09-06');
});

console.log('\n=== preset: month ===');

test('month runs from the 1st through today', () => {
  const r = resolveRange({ preset: 'month', nowMs: manila(2026, 9, 17, 12, 0) });
  assert.strictEqual(r.startDate, '2026-09-01');
  assert.strictEqual(r.endDate, '2026-09-17');
});

test('on the 1st, the month range is a single day', () => {
  const r = resolveRange({ preset: 'month', nowMs: manila(2026, 9, 1, 0, 30) });
  assert.strictEqual(r.startDate, '2026-09-01');
  assert.strictEqual(r.endDate, '2026-09-01');
  assert.strictEqual(r.spanDays, 1);
});

console.log('\n=== preset: custom ===');

test('custom single-day range is inclusive', () => {
  const r = resolveRange({ preset: 'custom', startDate: '2026-09-03', endDate: '2026-09-03' });
  assert.strictEqual(r.spanDays, 1);
  assert.strictEqual(r.startUtcMs, manila(2026, 9, 3, 0, 0));
  assert.strictEqual(r.endUtcMs, manila(2026, 9, 4, 0, 0));
});

test('custom multi-day range includes BOTH endpoints', () => {
  const r = resolveRange({ preset: 'custom', startDate: '2026-09-01', endDate: '2026-09-30' });
  assert.strictEqual(r.spanDays, 30);
  assert.ok(manila(2026, 9, 1, 0, 0) >= r.startUtcMs, 'first moment of Sep 1 included');
  assert.ok(manila(2026, 9, 30, 23, 59) < r.endUtcMs, 'last moment of Sep 30 included');
  assert.ok(manila(2026, 10, 1, 0, 0) >= r.endUtcMs, 'Oct 1 excluded');
});

test('range label is human readable', () => {
  assert.strictEqual(resolveRange({ preset: 'custom', startDate: '2026-09-01', endDate: '2026-09-30' }).label, 'Sep 1, 2026 – Sep 30, 2026');
  assert.strictEqual(resolveRange({ preset: 'custom', startDate: '2026-09-03', endDate: '2026-09-03' }).label, 'Sep 3, 2026');
});

test('reversed range is rejected', () => {
  throwsValidation(() => resolveRange({ preset: 'custom', startDate: '2026-09-30', endDate: '2026-09-01' }));
});

test('malformed / impossible dates are rejected', () => {
  throwsValidation(() => parseDateString('2026-9-3', 'From date'));
  throwsValidation(() => parseDateString('03/09/2026', 'From date'));
  throwsValidation(() => parseDateString('2026-02-30', 'From date'));
  throwsValidation(() => parseDateString('2026-13-01', 'From date'));
  throwsValidation(() => parseDateString(20260903, 'From date'));
});

test('absurdly large range is rejected', () => {
  throwsValidation(() => resolveRange({ preset: 'custom', startDate: '2021-01-01', endDate: '2026-12-31' }));
});

test('unknown preset is rejected', () => {
  throwsValidation(() => resolveRange({ preset: 'quarter' }));
});

console.log('\n=== summary aggregation: financial rules ===');

const ORDERS = [
  { paymentStatus: 'paid', fulfillmentStatus: 'completed', subtotal: 950, shippingFee: 180, total: 1130, isTest: false },
  { paymentStatus: 'paid', fulfillmentStatus: 'unfulfilled', subtotal: 500, shippingFee: 150, total: 650, isTest: false },
  { paymentStatus: 'pending_review', fulfillmentStatus: 'unfulfilled', subtotal: 300, shippingFee: 200, total: 500, isTest: false },
  { paymentStatus: 'awaiting_payment', fulfillmentStatus: 'unfulfilled', subtotal: 100, shippingFee: 0, total: 100, isTest: false },
  { paymentStatus: 'rejected', fulfillmentStatus: 'unfulfilled', subtotal: 999, shippingFee: 999, total: 1998, isTest: false },
];

test('only paid orders contribute to revenue', () => {
  const s = buildSummary(ORDERS);
  assert.strictEqual(s.grossPaidSales, 1130 + 650, 'unpaid/rejected must not count');
  assert.strictEqual(s.merchandiseSales, 950 + 500);
  assert.strictEqual(s.shippingCollected, 180 + 150);
});

test('order counts include every status', () => {
  const s = buildSummary(ORDERS);
  assert.strictEqual(s.totalOrders, 5);
  assert.strictEqual(s.paidOrders, 2);
  assert.strictEqual(s.pendingReview, 1);
  assert.strictEqual(s.awaitingPayment, 1);
  assert.strictEqual(s.rejected, 1);
});

test('average is over PAID orders only', () => {
  const s = buildSummary(ORDERS);
  assert.strictEqual(s.averagePaidOrderValue, (1130 + 650) / 2);
});

test('gross = merchandise + shipping (internally consistent)', () => {
  const s = buildSummary(ORDERS);
  assert.strictEqual(s.merchandiseSales + s.shippingCollected, s.grossPaidSales);
});

test('empty range yields zeros, not NaN', () => {
  const s = buildSummary([]);
  assert.strictEqual(s.totalOrders, 0);
  assert.strictEqual(s.grossPaidSales, 0);
  assert.strictEqual(s.averagePaidOrderValue, 0, 'must not divide by zero');
  assert.ok(Number.isFinite(s.averagePaidOrderValue));
});

test('a range with no PAID orders yields zero revenue and zero average', () => {
  const s = buildSummary(ORDERS.filter((o) => o.paymentStatus !== 'paid'));
  assert.strictEqual(s.grossPaidSales, 0);
  assert.strictEqual(s.averagePaidOrderValue, 0);
  assert.strictEqual(s.totalOrders, 3);
});

test('fulfillment breakdown counts every status', () => {
  const s = buildSummary(ORDERS);
  assert.strictEqual(s.fulfillmentBreakdown.completed, 1);
  assert.strictEqual(s.fulfillmentBreakdown.unfulfilled, 4);
  assert.strictEqual(s.fulfillmentBreakdown.shipped, 0);
});

console.log('\n=== order projection helpers ===');

test('payment method prefers the APPROVED attempt', () => {
  const m = derivePaymentMethod({
    paymentAttempts: [
      { paymentMethod: 'gcash', status: 'rejected' },
      { paymentMethod: 'bank_transfer', status: 'approved' },
    ],
  });
  assert.strictEqual(m, 'bank_transfer');
});

test('payment method falls back to the latest attempt', () => {
  const m = derivePaymentMethod({
    paymentAttempts: [
      { paymentMethod: 'gcash', status: 'rejected' },
      { paymentMethod: 'bank_transfer', status: 'pending_review' },
    ],
  });
  assert.strictEqual(m, 'bank_transfer');
});

test('no attempts yields null, never undefined or a crash', () => {
  assert.strictEqual(derivePaymentMethod({}), null);
  assert.strictEqual(derivePaymentMethod({ paymentAttempts: [] }), null);
});

test('destination labels, including historical orders', () => {
  assert.strictEqual(destinationLabel({ deliveryMethod: 'pickup' }), 'Pickup');
  assert.strictEqual(destinationLabel({ deliveryMethod: 'delivery', destinationRegion: 'visayas' }), 'Visayas');
  assert.strictEqual(destinationLabel({ deliveryMethod: 'delivery', destinationRegion: null }), 'Not recorded');
  assert.strictEqual(destinationLabel({ deliveryMethod: 'delivery' }), 'Not recorded');
});

test('Manila datetime rendering', () => {
  assert.strictEqual(manilaDateTime(manila(2026, 9, 3, 13, 41)), 'Sep 3, 2026 1:41 PM');
  assert.strictEqual(manilaDateTime(manila(2026, 9, 3, 0, 5)), 'Sep 3, 2026 12:05 AM');
  assert.strictEqual(manilaDateTime(manila(2026, 9, 3, 12, 0)), 'Sep 3, 2026 12:00 PM');
});

console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES ABOVE' : ' — all green') + '\n');
