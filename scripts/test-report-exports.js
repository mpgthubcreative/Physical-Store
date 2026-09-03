/*
 * OFFLINE TEST — proves the Excel and PDF generators produce genuine,
 * well-formed files from a known dataset, and that the numbers inside them
 * match the dashboard summary exactly.
 *
 * No credentials and no Firestore: the export module's builders are
 * exercised directly against a fixed order list, so this runs anywhere.
 *
 * Writes two sample files into .qa-artifacts/ so you can open them and
 * eyeball the formatting. That directory is gitignored.
 *
 * Usage: node scripts/test-report-exports.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ExcelJS = require('exceljs');

process.env.FIREBASE_STORAGE_BUCKET = 'buddy-shop-45fc4.firebasestorage.app';

const { resolveRange } = require('../netlify/functions/_shared/reportRange');
const { buildSummary } = require('../netlify/functions/_shared/reportData');

// The export module exports only a handler, so pull the builders out of it
// the same way the handler does — by requiring the module and reaching the
// functions through a fresh require of its dependencies. Simpler: replicate
// the handler's call shape by importing the module and invoking the
// internal builders via a light re-require.
const exportModulePath = require.resolve('../netlify/functions/admin-report-export.js');
const exportSrc = fs.readFileSync(exportModulePath, 'utf8');

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

/* ---------- fixture: a realistic mixed dataset ---------- */
const ORDERS = [
  {
    orderId: 'a1', orderNumber: 'BP-AAA111', createdAtMs: Date.UTC(2026, 8, 3, 5, 41),
    orderDate: 'Sep 3, 2026 1:41 PM', customerName: 'Maria Santos', customerEmail: 'maria@example.com',
    customerMobile: '09171234567', deliveryMethod: 'delivery', destinationRegion: 'visayas', destination: 'Visayas',
    subtotal: 950, shippingFee: 180, total: 1130, paymentMethod: 'gcash', paymentStatus: 'paid',
    fulfillmentStatus: 'shipped', courier: 'J&T', trackingNumber: 'JT123456', isTest: false,
  },
  {
    orderId: 'a2', orderNumber: 'BP-BBB222', createdAtMs: Date.UTC(2026, 8, 3, 2, 0),
    orderDate: 'Sep 3, 2026 10:00 AM', customerName: 'Jose Cruz', customerEmail: 'jose@example.com',
    customerMobile: '09181234567', deliveryMethod: 'pickup', destinationRegion: null, destination: 'Pickup',
    subtotal: 500, shippingFee: 0, total: 500, paymentMethod: 'bank_transfer', paymentStatus: 'paid',
    fulfillmentStatus: 'completed', courier: null, trackingNumber: null, isTest: false,
  },
  {
    // A historical order: no region, no courier, no tracking.
    orderId: 'a3', orderNumber: 'BP-CCC333', createdAtMs: Date.UTC(2026, 8, 2, 12, 0),
    orderDate: 'Sep 2, 2026 8:00 PM', customerName: 'Ana Reyes', customerEmail: 'ana@example.com',
    customerMobile: '09191234567', deliveryMethod: 'delivery', destinationRegion: null, destination: 'Not recorded',
    subtotal: 300, shippingFee: 80, total: 380, paymentMethod: null, paymentStatus: 'pending_review',
    fulfillmentStatus: 'unfulfilled', courier: null, trackingNumber: null, isTest: false,
  },
  {
    orderId: 'a4', orderNumber: 'BP-DDD444', createdAtMs: Date.UTC(2026, 8, 1, 12, 0),
    orderDate: 'Sep 1, 2026 8:00 PM', customerName: 'Rejected Buyer', customerEmail: 'rej@example.com',
    customerMobile: '09201234567', deliveryMethod: 'delivery', destinationRegion: 'luzon', destination: 'Luzon',
    subtotal: 999, shippingFee: 150, total: 1149, paymentMethod: 'gcash', paymentStatus: 'rejected',
    fulfillmentStatus: 'unfulfilled', courier: null, trackingNumber: null, isTest: false,
  },
];

const RANGE = resolveRange({ preset: 'custom', startDate: '2026-09-01', endDate: '2026-09-30' });
const SUMMARY = buildSummary(ORDERS);
const META = { testOrdersInRange: 2, fetchedCount: 6, truncated: false, maxOrders: 5000 };
const PAYLOAD = {
  range: { ...RANGE, generatedAt: RANGE.generatedAtManila },
  includeTest: false,
  summary: SUMMARY,
  orders: ORDERS,
  meta: META,
};

/*
 * Rebuild the two builders in this process by evaluating the export module
 * with its handler stripped — avoids exporting internals from production
 * code purely for tests, while still testing the real implementations.
 */
function loadBuilders() {
  const Module = require('module');
  const stripped = exportSrc.replace(/exports\.handler[\s\S]*$/, 'module.exports = { buildWorkbook, buildPdf };');
  const m = new Module(exportModulePath, null);
  m.filename = exportModulePath;
  m.paths = Module._nodeModulePaths(path.dirname(exportModulePath));
  m._compile(stripped, exportModulePath);
  return m.exports;
}

const OUT_DIR = path.join(__dirname, '..', '.qa-artifacts');

async function main() {
  const { buildWorkbook, buildPdf } = loadBuilders();
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('\n=== summary sanity (dashboard numbers) ===');
  await test('paid revenue counts only the two paid orders', () => {
    assert.strictEqual(SUMMARY.paidOrders, 2);
    assert.strictEqual(SUMMARY.grossPaidSales, 1130 + 500);
    assert.strictEqual(SUMMARY.merchandiseSales, 950 + 500);
    assert.strictEqual(SUMMARY.shippingCollected, 180 + 0);
    assert.strictEqual(SUMMARY.averagePaidOrderValue, 1630 / 2);
  });
  await test('rejected/pending orders are counted but contribute no revenue', () => {
    assert.strictEqual(SUMMARY.totalOrders, 4);
    assert.strictEqual(SUMMARY.rejected, 1);
    assert.strictEqual(SUMMARY.pendingReview, 1);
    assert.ok(!String(SUMMARY.grossPaidSales).includes('1149'));
  });

  console.log('\n=== Excel ===');
  const xlsxBuf = await buildWorkbook(PAYLOAD);
  const xlsxPath = path.join(OUT_DIR, 'sample-report.xlsx');
  fs.writeFileSync(xlsxPath, xlsxBuf);

  await test('is a real XLSX (ZIP/OOXML magic bytes, not a renamed CSV)', () => {
    assert.strictEqual(xlsxBuf[0], 0x50, 'byte 0 must be P');
    assert.strictEqual(xlsxBuf[1], 0x4b, 'byte 1 must be K');
    assert.ok(xlsxBuf.length > 5000, 'a real workbook is not tiny');
  });

  const rb = new ExcelJS.Workbook();
  await rb.xlsx.readFile(xlsxPath);

  await test('reopens with exactly two worksheets named Summary and Orders', () => {
    assert.strictEqual(rb.worksheets.length, 2);
    assert.strictEqual(rb.getWorksheet('Summary').name, 'Summary');
    assert.strictEqual(rb.getWorksheet('Orders').name, 'Orders');
  });

  await test('Summary sheet figures match the dashboard summary exactly', () => {
    const s = rb.getWorksheet('Summary');
    const found = {};
    s.eachRow((row) => {
      const k = row.getCell(1).value;
      const v = row.getCell(2).value;
      if (typeof k === 'string') found[k] = v;
    });
    assert.strictEqual(found['Total Orders'], SUMMARY.totalOrders);
    assert.strictEqual(found['Paid Orders'], SUMMARY.paidOrders);
    assert.strictEqual(found['Gross Paid Sales'], SUMMARY.grossPaidSales);
    assert.strictEqual(found['Merchandise Sales'], SUMMARY.merchandiseSales);
    assert.strictEqual(found['Shipping Collected'], SUMMARY.shippingCollected);
    assert.strictEqual(found['Average Paid Order Value'], SUMMARY.averagePaidOrderValue);
    assert.strictEqual(found['Rejected'], SUMMARY.rejected);
  });

  await test('money cells are real NUMBERS with a currency format, not text', () => {
    const o = rb.getWorksheet('Orders');
    const firstDataRow = o.getRow(2);
    assert.strictEqual(typeof firstDataRow.getCell(10).value, 'number', 'Grand Total must be numeric');
    assert.ok(String(firstDataRow.getCell(10).numFmt || '').includes('#,##0.00'), 'must carry a currency number format');
  });

  await test('Orders sheet has all 16 required columns in order', () => {
    const o = rb.getWorksheet('Orders');
    const headers = o.getRow(1).values.slice(1);
    assert.deepStrictEqual(headers, [
      'Order Number', 'Order Date', 'Customer Name', 'Email', 'Mobile',
      'Delivery Method', 'Destination Region', 'Subtotal', 'Shipping', 'Grand Total',
      'Payment Method', 'Payment Status', 'Fulfillment Status', 'Courier', 'Tracking Number', 'TEST Order',
    ]);
  });

  await test('historical order exports as "Not recorded"/blank, never an error', () => {
    const o = rb.getWorksheet('Orders');
    let hist = null;
    o.eachRow((row) => {
      if (row.getCell(1).value === 'BP-CCC333') hist = row;
    });
    assert.ok(hist, 'historical order row must exist');
    assert.strictEqual(hist.getCell(7).value, 'Not recorded', 'missing region');
    assert.strictEqual(hist.getCell(11).value, 'Not recorded', 'no payment attempt yet');
    assert.strictEqual(hist.getCell(14).value, '', 'no courier');
    assert.strictEqual(hist.getCell(15).value, '', 'no tracking');
  });

  await test('no access tokens, hashes, or internal auth fields anywhere in the workbook', () => {
    const raw = xlsxBuf.toString('latin1');
    for (const forbidden of ['accessTokenHash', 'idempotencyKey', 'orderAccessToken', 'referencedProductIds', 'serviceAccount', 'private_key']) {
      assert.ok(!raw.includes(forbidden), `workbook must not contain ${forbidden}`);
    }
  });

  console.log('\n=== PDF ===');
  const pdfBuf = await buildPdf(PAYLOAD);
  const pdfPath = path.join(OUT_DIR, 'sample-report.pdf');
  fs.writeFileSync(pdfPath, pdfBuf);

  await test('is a real PDF (%PDF header, EOF marker)', () => {
    assert.strictEqual(pdfBuf.slice(0, 5).toString(), '%PDF-');
    assert.ok(pdfBuf.slice(-1024).toString('latin1').includes('%%EOF'));
    assert.ok(pdfBuf.length > 3000);
  });

  await test('no secrets leak into the PDF', () => {
    const raw = pdfBuf.toString('latin1');
    for (const forbidden of ['accessTokenHash', 'idempotencyKey', 'private_key']) {
      assert.ok(!raw.includes(forbidden), `PDF must not contain ${forbidden}`);
    }
  });

  await test('a large dataset paginates without throwing', async () => {
    const many = [];
    for (let i = 0; i < 250; i++) {
      many.push({ ...ORDERS[0], orderId: 'x' + i, orderNumber: 'BP-X' + String(i).padStart(5, '0') });
    }
    const big = await buildPdf({ ...PAYLOAD, orders: many, summary: buildSummary(many) });
    assert.strictEqual(big.slice(0, 5).toString(), '%PDF-');
    assert.ok(big.length > pdfBuf.length, 'more orders must produce a larger document');
  });

  await test('an empty range still renders both files cleanly', async () => {
    const empty = { ...PAYLOAD, orders: [], summary: buildSummary([]), meta: { ...META, testOrdersInRange: 0 } };
    const x = await buildWorkbook(empty);
    const p = await buildPdf(empty);
    assert.strictEqual(x[0], 0x50);
    assert.strictEqual(p.slice(0, 5).toString(), '%PDF-');
  });

  console.log(`\n  artifacts written to .qa-artifacts/`);
  console.log(`    ${(xlsxBuf.length / 1024).toFixed(1)} KB  sample-report.xlsx`);
  console.log(`    ${(pdfBuf.length / 1024).toFixed(1)} KB  sample-report.pdf`);
  console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES ABOVE' : ' — all green') + '\n');
}

main().catch((err) => {
  console.error('Export test crashed:', err);
  process.exit(1);
});
