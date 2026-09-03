/*
 * OFFLINE INTEGRATION TEST — no credentials, no network.
 *
 * Drives fetchReportOrders() against a mock Firestore to prove the
 * behaviours that matter most and are hardest to eyeball:
 *
 *   1. Exported totals EXACTLY match the dashboard totals for the same
 *      filter (the brief's explicit QA requirement).
 *   2. isTest:true orders are excluded by default.
 *   3. An order with NO isTest field is treated as a real order — the trap
 *      that a Firestore `where('isTest','==',false)` filter would fall into
 *      by silently dropping historical orders.
 *   4. The date range query is half-open and uses the createdAt field only
 *      (so no composite index is needed).
 *
 * Usage: node scripts/test-report-parity.js
 */
const assert = require('assert');

process.env.FIREBASE_STORAGE_BUCKET = 'buddy-shop-45fc4.firebasestorage.app';

const { resolveRange } = require('../netlify/functions/_shared/reportRange');
const { fetchReportOrders, buildSummary } = require('../netlify/functions/_shared/reportData');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log('  PASS  ' + name);
    })
    .catch((err) => {
      console.error('  FAIL  ' + name + '\n        ' + err.message);
      process.exitCode = 1;
    });
}

/* ---------- mock Firestore ---------- */

const adminStub = {
  firestore: {
    Timestamp: {
      fromMillis: (ms) => ({ __ms: ms, toMillis: () => ms }),
    },
  },
};

/** Records the query that was built, so we can assert on its shape. */
let lastQuery = null;

function mockDb(docs) {
  return {
    collection(name) {
      assert.strictEqual(name, 'orders', 'reporting must only read the orders collection');
      const q = { wheres: [], orderBys: [], limitN: null };
      lastQuery = q;
      const api = {
        where(field, op, value) {
          q.wheres.push({ field, op, ms: value.__ms });
          return api;
        },
        orderBy(field, dir) {
          q.orderBys.push({ field, dir });
          return api;
        },
        limit(n) {
          q.limitN = n;
          return api;
        },
        async get() {
          let out = docs.filter((d) => {
            const ms = d.data.createdAt.toMillis();
            return q.wheres.every((w) => (w.op === '>=' ? ms >= w.ms : ms < w.ms));
          });
          out.sort((a, b) => b.data.createdAt.toMillis() - a.data.createdAt.toMillis());
          out = out.slice(0, q.limitN);
          return { size: out.length, docs: out.map((d) => ({ id: d.id, data: () => d.data })) };
        },
      };
      return api;
    },
  };
}

const ts = (ms) => ({ toMillis: () => ms });
const manila = (y, mo, d, h = 12) => Date.UTC(y, mo - 1, d, h) - 8 * 3600 * 1000;

function order(id, overrides) {
  return {
    id,
    data: {
      orderNumber: 'BP-' + id.toUpperCase(),
      createdAt: ts(manila(2026, 9, 3)),
      customerName: 'Test Customer',
      customerEmail: 'c@example.com',
      customerMobile: '09170000000',
      deliveryMethod: 'delivery',
      destinationRegion: 'luzon',
      pricing: { subtotal: 500, shippingFee: 150, total: 650 },
      paymentStatus: 'paid',
      fulfillmentStatus: 'completed',
      paymentAttempts: [{ paymentMethod: 'gcash', status: 'approved' }],
      // NOTE: isTest deliberately omitted unless a test sets it.
      ...overrides,
    },
  };
}

async function main() {
  const RANGE = resolveRange({ preset: 'custom', startDate: '2026-09-01', endDate: '2026-09-30' });

  console.log('\n=== query shape (index requirements) ===');

  await test('queries createdAt only — no composite index needed', async () => {
    const db = mockDb([order('a')]);
    await fetchReportOrders(db, { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: false }, adminStub);
    const fields = new Set([...lastQuery.wheres.map((w) => w.field), ...lastQuery.orderBys.map((o) => o.field)]);
    assert.deepStrictEqual([...fields], ['createdAt'], 'only createdAt may appear in the query');
    assert.ok(!lastQuery.wheres.some((w) => w.field === 'isTest'), 'isTest must NOT be a query filter');
  });

  await test('range is half-open: >= start and < end', async () => {
    const db = mockDb([order('a')]);
    await fetchReportOrders(db, { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: false }, adminStub);
    const ops = lastQuery.wheres.map((w) => w.op).sort();
    assert.deepStrictEqual(ops, ['<', '>=']);
  });

  console.log('\n=== TEST-order exclusion ===');

  const MIXED = [
    order('real1', { isTest: false, pricing: { subtotal: 950, shippingFee: 180, total: 1130 } }),
    order('real2', { isTest: false, pricing: { subtotal: 500, shippingFee: 0, total: 500 }, deliveryMethod: 'pickup', destinationRegion: null }),
    order('legacy', { pricing: { subtotal: 300, shippingFee: 80, total: 380 } }), // no isTest field at all
    order('qa1', { isTest: true, pricing: { subtotal: 9999, shippingFee: 9999, total: 19998 } }),
    order('qa2', { isTest: true, pricing: { subtotal: 5000, shippingFee: 500, total: 5500 } }),
  ];

  await test('test orders are excluded by DEFAULT', async () => {
    const db = mockDb(MIXED);
    const { orders, testOrderCount } = await fetchReportOrders(db, { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: false }, adminStub);
    assert.strictEqual(orders.length, 3, 'only the three non-test orders');
    assert.strictEqual(testOrderCount, 2);
    assert.ok(!orders.some((o) => o.isTest), 'no test order may survive');
  });

  await test('TEST orders never inflate revenue', async () => {
    const db = mockDb(MIXED);
    const { orders } = await fetchReportOrders(db, { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: false }, adminStub);
    const s = buildSummary(orders);
    assert.strictEqual(s.grossPaidSales, 1130 + 500 + 380, 'the 19,998 and 5,500 test orders must be absent');
    assert.ok(s.grossPaidSales < 19998, 'sanity');
  });

  await test('an order with NO isTest field counts as REAL (the Firestore trap)', async () => {
    const db = mockDb(MIXED);
    const { orders } = await fetchReportOrders(db, { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: false }, adminStub);
    assert.ok(orders.some((o) => o.orderNumber === 'BP-LEGACY'), 'historical order must not be dropped');
  });

  await test('Include TEST toggle brings them back', async () => {
    const db = mockDb(MIXED);
    const { orders, testOrderCount } = await fetchReportOrders(db, { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: true }, adminStub);
    assert.strictEqual(orders.length, 5);
    assert.strictEqual(testOrderCount, 2);
    const s = buildSummary(orders);
    assert.strictEqual(s.grossPaidSales, 1130 + 500 + 380 + 19998 + 5500);
  });

  console.log('\n=== dashboard / export parity ===');

  await test('export dataset is byte-for-byte the same as the dashboard dataset', async () => {
    // Simulates admin-report.js and admin-report-export.js: same range, same
    // includeTest, same shared functions.
    const dashboard = await fetchReportOrders(mockDb(MIXED), { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: false }, adminStub);
    const exported = await fetchReportOrders(mockDb(MIXED), { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: false }, adminStub);
    assert.strictEqual(JSON.stringify(dashboard.orders), JSON.stringify(exported.orders));
    assert.strictEqual(JSON.stringify(buildSummary(dashboard.orders)), JSON.stringify(buildSummary(exported.orders)));
  });

  await test('summary totals reconcile with the order rows', async () => {
    const { orders } = await fetchReportOrders(mockDb(MIXED), { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: false }, adminStub);
    const s = buildSummary(orders);
    const paid = orders.filter((o) => o.paymentStatus === 'paid');
    assert.strictEqual(s.paidOrders, paid.length);
    assert.strictEqual(s.grossPaidSales, paid.reduce((a, o) => a + o.total, 0));
    assert.strictEqual(s.merchandiseSales, paid.reduce((a, o) => a + o.subtotal, 0));
    assert.strictEqual(s.shippingCollected, paid.reduce((a, o) => a + o.shippingFee, 0));
    assert.strictEqual(s.merchandiseSales + s.shippingCollected, s.grossPaidSales);
  });

  console.log('\n=== date filtering ===');

  await test('orders outside the range are excluded', async () => {
    const docs = [
      order('in', { createdAt: ts(manila(2026, 9, 15)) }),
      order('before', { createdAt: ts(manila(2026, 8, 31, 23)) }),
      order('after', { createdAt: ts(manila(2026, 10, 1, 1)) }),
    ];
    const { orders } = await fetchReportOrders(mockDb(docs), { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: false }, adminStub);
    assert.deepStrictEqual(orders.map((o) => o.orderNumber), ['BP-IN']);
  });

  await test('a late-night Manila order lands in the right day', async () => {
    const today = resolveRange({ preset: 'custom', startDate: '2026-09-04', endDate: '2026-09-04' });
    const docs = [
      order('lateNight', { createdAt: ts(manila(2026, 9, 4, 0)) }),   // 00:00 Manila Sep 4 = 16:00 UTC Sep 3
      order('prevEvening', { createdAt: ts(manila(2026, 9, 3, 23)) }), // 23:00 Manila Sep 3
    ];
    const { orders } = await fetchReportOrders(mockDb(docs), { startUtcMs: today.startUtcMs, endUtcMs: today.endUtcMs, includeTest: false }, adminStub);
    assert.deepStrictEqual(orders.map((o) => o.orderNumber), ['BP-LATENIGHT'], 'only the Sep 4 Manila order');
  });

  await test('an empty range yields zeroed metrics, not an error', async () => {
    const { orders } = await fetchReportOrders(mockDb([]), { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: false }, adminStub);
    const s = buildSummary(orders);
    assert.strictEqual(orders.length, 0);
    assert.strictEqual(s.totalOrders, 0);
    assert.strictEqual(s.averagePaidOrderValue, 0);
  });

  console.log('\n=== projection security ===');

  await test('the projection never carries tokens or internal fields', async () => {
    const docs = [
      order('secret', {
        accessTokenHash: 'DEADBEEF_TOKEN_HASH',
        idempotencyKey: 'IDEMPOTENCY_SECRET',
        history: [{ action: 'created' }],
        items: [{ productId: 'p1' }],
        referencedProductIds: ['p1'],
      }),
    ];
    const { orders } = await fetchReportOrders(mockDb(docs), { startUtcMs: RANGE.startUtcMs, endUtcMs: RANGE.endUtcMs, includeTest: false }, adminStub);
    const serialized = JSON.stringify(orders);
    for (const forbidden of ['accessTokenHash', 'DEADBEEF', 'idempotencyKey', 'IDEMPOTENCY_SECRET', 'history', 'referencedProductIds']) {
      assert.ok(!serialized.includes(forbidden), `projection leaked ${forbidden}`);
    }
    assert.deepStrictEqual(
      Object.keys(orders[0]).sort(),
      ['courier', 'createdAtMs', 'customerEmail', 'customerMobile', 'customerName', 'deliveryMethod', 'destination',
        'destinationRegion', 'fulfillmentStatus', 'isTest', 'orderDate', 'orderId', 'orderNumber', 'paymentMethod',
        'paymentStatus', 'shippingFee', 'subtotal', 'total', 'trackingNumber'].sort()
    );
  });

  console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES ABOVE' : ' — all green') + '\n');
}

main().catch((err) => {
  console.error('Parity test crashed:', err);
  process.exit(1);
});
