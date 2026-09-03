/*
 * GET /api/admin-report-export?format=xlsx|pdf&preset=&startDate=&endDate=&includeTest=
 *
 * Owner AND Admin (requireAdmin), same as admin-report.js.
 *
 * ---- Why exports are generated SERVER-SIDE ----
 * The brief requires that an export can never show a different dataset from
 * the dashboard that produced it. Generating here guarantees that
 * structurally: this endpoint takes the SAME query parameters, calls the
 * SAME resolveRange(), the SAME fetchReportOrders() and the SAME
 * buildSummary() as admin-report.js. There is no second implementation that
 * could drift. Client-side generation would also mean shipping a large
 * library to every admin page load and re-deriving the numbers in the
 * browser — two more chances to disagree.
 *
 * ---- Real .xlsx, not a renamed CSV ----
 * ExcelJS writes a genuine OOXML workbook (a ZIP of XML parts) with two
 * worksheets, typed numeric cells, currency number formats, frozen headers
 * and column widths. Opening it in Excel/Sheets gives real numbers you can
 * sum, not text.
 *
 * ---- PDF ----
 * PDFKit draws a laid-out document — a branded header, summary blocks, the
 * two status breakdowns, and a paginated order table with a repeating
 * header row. It is not a screenshot of the dashboard.
 *
 * ---- Security ----
 * Both exports use the strict reporting projection from _shared/reportData.js.
 * accessTokenHash, idempotencyKey, order history, and the customization
 * snapshot are never read into the projection, so they cannot reach a file.
 * READ-ONLY: nothing here writes to Firestore.
 */
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const { admin, getDb } = require('./_shared/firebaseAdmin');
const { requireAdmin } = require('./_shared/adminAuth');
const { withErrorHandling, fail } = require('./_shared/response');
const { requireOneOf } = require('./_shared/validation');
const { resolveRange } = require('./_shared/reportRange');
const { fetchReportOrders, buildSummary, PAYMENT_STATUSES, FULFILLMENT_STATUSES } = require('./_shared/reportData');

const PAYMENT_LABELS = {
  awaiting_payment: 'Awaiting Payment',
  pending_review: 'Pending Review',
  paid: 'Paid',
  rejected: 'Rejected',
};
const FULFILLMENT_LABELS = {
  unfulfilled: 'Unfulfilled',
  processing: 'Processing',
  ready_for_pickup: 'Ready for Pickup',
  shipped: 'Shipped',
  completed: 'Completed',
};
const METHOD_LABELS = { gcash: 'GCash', bank_transfer: 'Bank Transfer' };

// Buddy palette, matching the storefront/admin design tokens.
const INK = '#2C4A4A';
const TEAL = '#38B2B3';
const CORAL = '#F16861';
const MUTED = '#6B7674';
const BORDER = '#DDE5E3';

const PESO = '₱';
const CURRENCY_FMT = '"₱"#,##0.00';

function label(map, key) {
  return map[key] || key || '';
}
function methodLabel(m) {
  if (!m) return 'Not recorded';
  return METHOD_LABELS[m] || m;
}
function fileStamp(range) {
  return `Buddy-Patches-Report-${range.startDate}-to-${range.endDate}`;
}

/* =====================================================================
   EXCEL
   ===================================================================== */

async function buildWorkbook({ range, includeTest, summary, orders, meta }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Buddy Patches Admin';
  wb.created = new Date();

  /* ---------- Sheet 1: Summary ---------- */
  const s = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  s.columns = [{ width: 34 }, { width: 22 }];

  let r = 1;
  const title = (text, size) => {
    const cell = s.getCell(r, 1);
    cell.value = text;
    cell.font = { bold: true, size, color: { argb: 'FF2C4A4A' } };
    s.mergeCells(r, 1, r, 2);
    r++;
  };
  const meta2 = (k, v) => {
    s.getCell(r, 1).value = k;
    s.getCell(r, 1).font = { color: { argb: 'FF6B7674' } };
    s.getCell(r, 2).value = v;
    r++;
  };
  const section = (text) => {
    r++;
    const cell = s.getCell(r, 1);
    cell.value = text;
    cell.font = { bold: true, size: 12, color: { argb: 'FF38B2B3' } };
    s.mergeCells(r, 1, r, 2);
    r++;
  };
  const row = (k, v, opts = {}) => {
    s.getCell(r, 1).value = k;
    const cell = s.getCell(r, 2);
    cell.value = v;
    if (opts.currency) cell.numFmt = CURRENCY_FMT;
    if (opts.bold) {
      s.getCell(r, 1).font = { bold: true };
      cell.font = { bold: true };
    }
    r++;
  };

  title('Buddy Patches', 18);
  title('Sales & Orders Report', 14);
  r++;
  meta2('Report period', range.label);
  meta2('Generated', range.generatedAt);
  meta2('Test orders', includeTest ? 'INCLUDED' : 'Excluded');
  if (!includeTest && meta.testOrdersInRange > 0) {
    meta2('Test orders hidden', meta.testOrdersInRange);
  }
  if (meta.truncated) {
    meta2('NOTE', `Capped at ${meta.maxOrders} orders — narrow the date range for a complete report.`);
  }

  section('Orders');
  row('Total Orders', summary.totalOrders);
  row('Paid Orders', summary.paidOrders);
  row('Awaiting Payment', summary.awaitingPayment);
  row('Pending Review', summary.pendingReview);
  row('Rejected', summary.rejected);

  section('Sales (paid orders only)');
  row('Gross Paid Sales', summary.grossPaidSales, { currency: true, bold: true });
  row('Merchandise Sales', summary.merchandiseSales, { currency: true });
  row('Shipping Collected', summary.shippingCollected, { currency: true });
  row('Average Paid Order Value', summary.averagePaidOrderValue, { currency: true });

  section('Payment Breakdown');
  for (const st of PAYMENT_STATUSES) row(label(PAYMENT_LABELS, st), summary.paymentBreakdown[st]);

  section('Fulfillment Breakdown');
  for (const st of FULFILLMENT_STATUSES) row(label(FULFILLMENT_LABELS, st), summary.fulfillmentBreakdown[st]);

  /* ---------- Sheet 2: Orders ---------- */
  const o = wb.addWorksheet('Orders', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  o.columns = [
    { header: 'Order Number', key: 'orderNumber', width: 16 },
    { header: 'Order Date', key: 'orderDate', width: 22 },
    { header: 'Customer Name', key: 'customerName', width: 24 },
    { header: 'Email', key: 'customerEmail', width: 28 },
    { header: 'Mobile', key: 'customerMobile', width: 16 },
    { header: 'Delivery Method', key: 'deliveryMethod', width: 16 },
    { header: 'Destination Region', key: 'destination', width: 18 },
    { header: 'Subtotal', key: 'subtotal', width: 13 },
    { header: 'Shipping', key: 'shippingFee', width: 13 },
    { header: 'Grand Total', key: 'total', width: 14 },
    { header: 'Payment Method', key: 'paymentMethod', width: 17 },
    { header: 'Payment Status', key: 'paymentStatus', width: 17 },
    { header: 'Fulfillment Status', key: 'fulfillmentStatus', width: 18 },
    { header: 'Courier', key: 'courier', width: 16 },
    { header: 'Tracking Number', key: 'trackingNumber', width: 20 },
    { header: 'TEST Order', key: 'isTest', width: 11 },
  ];

  const header = o.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C4A4A' } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;

  for (const ord of orders) {
    o.addRow({
      orderNumber: ord.orderNumber,
      orderDate: ord.orderDate,
      customerName: ord.customerName,
      customerEmail: ord.customerEmail,
      customerMobile: ord.customerMobile,
      deliveryMethod: ord.deliveryMethod === 'pickup' ? 'Pickup' : 'Delivery',
      // Historical orders with no region export as "Not recorded", never blank-with-an-error.
      destination: ord.destination,
      subtotal: ord.subtotal,
      shippingFee: ord.shippingFee,
      total: ord.total,
      paymentMethod: methodLabel(ord.paymentMethod),
      paymentStatus: label(PAYMENT_LABELS, ord.paymentStatus),
      fulfillmentStatus: label(FULFILLMENT_LABELS, ord.fulfillmentStatus),
      courier: ord.courier || '',
      trackingNumber: ord.trackingNumber || '',
      isTest: ord.isTest ? 'YES' : '',
    });
  }

  // Real numeric cells with a currency format — summable in Excel.
  for (const col of ['H', 'I', 'J']) {
    o.getColumn(col).numFmt = CURRENCY_FMT;
    o.getColumn(col).alignment = { horizontal: 'right' };
  }

  if (orders.length) {
    o.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 16 } };
    // Totals row so the workbook reconciles against the Summary sheet.
    const totalRow = o.addRow({
      orderNumber: 'TOTAL',
      subtotal: orders.reduce((a, x) => a + x.subtotal, 0),
      shippingFee: orders.reduce((a, x) => a + x.shippingFee, 0),
      total: orders.reduce((a, x) => a + x.total, 0),
    });
    totalRow.font = { bold: true };
    totalRow.getCell(8).numFmt = CURRENCY_FMT;
    totalRow.getCell(9).numFmt = CURRENCY_FMT;
    totalRow.getCell(10).numFmt = CURRENCY_FMT;
    // Note: this row totals ALL orders in range (every status), while the
    // Summary sheet's sales figures count PAID orders only. Labelled so the
    // difference is never mistaken for an inconsistency.
    totalRow.getCell(11).value = 'all statuses';
    totalRow.getCell(11).font = { italic: true, color: { argb: 'FF6B7674' } };
  } else {
    o.addRow({ orderNumber: 'No orders in this date range.' }).font = { italic: true, color: { argb: 'FF6B7674' } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* =====================================================================
   PDF
   ===================================================================== */

function money(n) {
  return PESO + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildPdf({ range, includeTest, summary, orders, meta }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = doc.page.margins.left;
    const R = doc.page.width - doc.page.margins.right;
    const W = R - L;

    /* ---------- header ---------- */
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text('Buddy Patches', L, 46);
    doc.fillColor(TEAL).font('Helvetica-Bold').fontSize(13).text('Sales & Orders Report', L, 74);
    doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(range.label, L, 93);
    doc.fontSize(8).text(`Generated ${range.generatedAt}`, L, 107);
    if (!includeTest) {
      doc.text('Test orders excluded' + (meta.testOrdersInRange ? ` (${meta.testOrdersInRange} hidden)` : ''), L, 118);
    } else {
      doc.fillColor(CORAL).text('TEST ORDERS INCLUDED — not a clean revenue report', L, 118);
    }
    doc.moveTo(L, 134).lineTo(R, 134).strokeColor(BORDER).lineWidth(1).stroke();

    let y = 150;

    /* ---------- summary tiles ---------- */
    const tiles = [
      ['Total Orders', String(summary.totalOrders)],
      ['Paid Orders', String(summary.paidOrders)],
      ['Gross Sales', money(summary.grossPaidSales)],
      ['Merchandise', money(summary.merchandiseSales)],
      ['Shipping', money(summary.shippingCollected)],
      ['Avg Order', money(summary.averagePaidOrderValue)],
    ];
    const perRow = 3;
    const gap = 10;
    const tileW = (W - gap * (perRow - 1)) / perRow;
    const tileH = 50;

    tiles.forEach((t, i) => {
      const col = i % perRow;
      const rowI = Math.floor(i / perRow);
      const x = L + col * (tileW + gap);
      const ty = y + rowI * (tileH + gap);
      doc.roundedRect(x, ty, tileW, tileH, 6).fillColor('#F5F9F8').fill();
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text(t[0].toUpperCase(), x + 10, ty + 9, { width: tileW - 20 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(t[1], x + 10, ty + 22, { width: tileW - 20, ellipsis: true });
    });
    y += Math.ceil(tiles.length / perRow) * (tileH + gap) + 8;

    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text('Sales figures count PAID orders only, using each order\'s stored pricing snapshot.', L, y);
    y += 18;

    /* ---------- breakdowns, side by side ---------- */
    const colW = (W - 20) / 2;
    const startY = y;

    const breakdown = (x, heading, entries) => {
      let by = startY;
      doc.fillColor(TEAL).font('Helvetica-Bold').fontSize(10).text(heading, x, by);
      by += 16;
      for (const [k, v] of entries) {
        doc.fillColor(INK).font('Helvetica').fontSize(9).text(k, x, by, { width: colW - 50 });
        doc.font('Helvetica-Bold').text(String(v), x + colW - 45, by, { width: 45, align: 'right' });
        by += 14;
      }
      return by;
    };

    const y1 = breakdown(L, 'Payment Status', PAYMENT_STATUSES.map((st) => [label(PAYMENT_LABELS, st), summary.paymentBreakdown[st]]));
    const y2 = breakdown(L + colW + 20, 'Fulfillment', FULFILLMENT_STATUSES.map((st) => [label(FULFILLMENT_LABELS, st), summary.fulfillmentBreakdown[st]]));
    y = Math.max(y1, y2) + 16;

    /* ---------- orders table ---------- */
    const cols = [
      { key: 'orderNumber', label: 'Order #', w: 70 },
      { key: 'orderDate', label: 'Date', w: 95 },
      { key: 'customerName', label: 'Customer', w: 105 },
      { key: 'destination', label: 'Destination', w: 70 },
      { key: 'total', label: 'Total', w: 62, align: 'right', money: true },
      { key: 'paymentStatus', label: 'Payment', w: 72, map: PAYMENT_LABELS },
      { key: 'fulfillmentStatus', label: 'Fulfillment', w: 75, map: FULFILLMENT_LABELS },
    ];
    const rowH = 15;
    const BOTTOM = doc.page.height - doc.page.margins.bottom - 24;

    const drawTableHeader = (ty) => {
      doc.rect(L, ty, W, 17).fillColor(INK).fill();
      let x = L;
      for (const c of cols) {
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7.5)
          .text(c.label.toUpperCase(), x + 4, ty + 5, { width: c.w - 8, align: c.align || 'left', ellipsis: true });
        x += c.w;
      }
      return ty + 17;
    };

    doc.fillColor(TEAL).font('Helvetica-Bold').fontSize(10).text(`Orders (${orders.length})`, L, y);
    y += 16;

    if (!orders.length) {
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9).text('No orders in this date range.', L, y);
    } else {
      y = drawTableHeader(y);

      orders.forEach((ord, i) => {
        // Paginate properly: new page, repeat the header row.
        if (y + rowH > BOTTOM) {
          doc.addPage();
          y = doc.page.margins.top;
          y = drawTableHeader(y);
        }
        if (i % 2 === 1) doc.rect(L, y, W, rowH).fillColor('#FAFCFB').fill();

        let x = L;
        for (const c of cols) {
          let v = ord[c.key];
          if (c.map) v = label(c.map, v);
          if (c.money) v = money(v);
          if (v == null || v === '') v = '—';
          doc.fillColor(ord.isTest ? MUTED : INK).font('Helvetica').fontSize(7.5)
            .text(String(v), x + 4, y + 4, { width: c.w - 8, align: c.align || 'left', lineBreak: false, ellipsis: true });
          x += c.w;
        }
        y += rowH;
      });

      if (meta.truncated) {
        y += 8;
        doc.fillColor(CORAL).font('Helvetica-Bold').fontSize(8)
          .text(`Capped at ${meta.maxOrders} orders. Narrow the date range for a complete report.`, L, y, { width: W });
      }
    }

    /* ---------- page numbers ---------- */
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
        .text(`Buddy Patches — ${range.label}    Page ${i + 1} of ${pages.count}`,
          L, doc.page.height - doc.page.margins.bottom - 12, { width: W, align: 'center' });
    }

    doc.end();
  });
}

/* =====================================================================
   HANDLER
   ===================================================================== */

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed.');

  const auth = await requireAdmin(event);
  if (!auth.ok) return fail(auth.status, auth.error);

  const params = event.queryStringParameters || {};
  const format = requireOneOf(params.format, 'format', ['xlsx', 'pdf']);
  const includeTest = params.includeTest === 'true';

  // Identical resolution to admin-report.js — same function, same inputs.
  const range = resolveRange({ preset: params.preset, startDate: params.startDate, endDate: params.endDate });

  const db = getDb();
  const { orders, truncated, testOrderCount, fetchedCount } = await fetchReportOrders(
    db,
    { startUtcMs: range.startUtcMs, endUtcMs: range.endUtcMs, includeTest },
    admin
  );
  const summary = buildSummary(orders);
  const meta = { testOrdersInRange: includeTest ? 0 : testOrderCount, fetchedCount, truncated, maxOrders: 5000 };

  const payload = { range: { ...range, generatedAt: range.generatedAtManila }, includeTest, summary, orders, meta };

  const isXlsx = format === 'xlsx';
  const buffer = isXlsx ? await buildWorkbook(payload) : await buildPdf(payload);
  const filename = `${fileStamp(range)}.${isXlsx ? 'xlsx' : 'pdf'}`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
    // Netlify returns binary only when the body is base64 and this flag is set.
    body: buffer.toString('base64'),
    isBase64Encoded: true,
  };
});
