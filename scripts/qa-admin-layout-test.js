/*
 * ADMIN LAYOUT / RESPONSIVENESS TEST — local, no credentials, no production data.
 *
 * Drives the real admin HTML/CSS/JS in local Chrome to answer the one
 * browser question that does NOT depend on production data: does any admin
 * page overflow horizontally at mobile widths?
 *
 * Page-level horizontal overflow is a property of the CSS and the DOM
 * structure, not of the values inside the data. So this runs the genuine
 * stylesheets and genuine render code against realistic STUBBED API
 * responses, at the four widths the brief names.
 *
 * What is stubbed, and why that is honest:
 *   - The Firebase Auth SDK (loaded from gstatic) is replaced with a tiny
 *     module exposing the same surface admin-auth.js uses, resolving to a
 *     fake signed-in Owner. No real account is touched.
 *   - /api/* responses are stubbed with realistic shapes taken from the
 *     actual endpoint contracts, including long customer names and many
 *     rows, which is the case most likely to overflow.
 *
 * What this does NOT prove: real Firestore latency, real production data
 * rendering, or authenticated behaviour. Those need a real signed-in
 * session, which this script deliberately does not attempt.
 *
 * Usage: node scripts/qa-admin-layout-test.js
 * Artifacts (screenshots) are written to .qa-artifacts/layout/.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.qa-artifacts', 'layout');
const PORT = 8642;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const WIDTHS = [428, 390, 375, 320];
const DESKTOP = 1440;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
};

/* ---------------------------------------------------------------------
   Stub Firebase Auth SDK — same surface admin-auth.js / firebase-init.js use
--------------------------------------------------------------------- */
const FIREBASE_APP_STUB = `export function initializeApp(config){ return { name:'[STUB]', options:config }; }`;

const FIREBASE_AUTH_STUB = `
const user = {
  uid: 'stub-owner-uid',
  email: 'owner@buddypatches.test',
  getIdToken: async () => 'stub-id-token',
  getIdTokenResult: async () => ({ claims: { admin: true, role: 'owner' } }),
};
export function getAuth(){ return { currentUser: user }; }
export function onAuthStateChanged(auth, cb){ setTimeout(() => cb(user), 0); return () => {}; }
export async function signInWithEmailAndPassword(){ return { user }; }
export async function signOut(){ }
`;

/* ---------------------------------------------------------------------
   Stubbed API responses — realistic shapes, deliberately stressful content
--------------------------------------------------------------------- */

const LONG_NAME = 'Maria Cristina Bernadette Villanueva-Santos';
const LONG_EMAIL = 'maria.cristina.bernadette@averylongdomainname.example.com';

function makeOrders(n) {
  const regions = ['luzon', 'visayas', 'mindanao', null];
  const pay = ['paid', 'pending_review', 'awaiting_payment', 'rejected'];
  const ful = ['completed', 'unfulfilled', 'processing', 'shipped', 'ready_for_pickup'];
  return Array.from({ length: n }, (_, i) => ({
    orderId: 'ord' + i,
    orderNumber: 'BP-' + String(i).padStart(6, '0'),
    createdAtMs: Date.now() - i * 3600000,
    orderDate: 'Sep 3, 2026 1:41 PM',
    customerName: i % 3 === 0 ? LONG_NAME : 'Jose Cruz',
    customerEmail: i % 3 === 0 ? LONG_EMAIL : 'jose@example.com',
    customerMobile: '09171234567',
    deliveryMethod: i % 4 === 3 ? 'pickup' : 'delivery',
    destinationRegion: regions[i % 4],
    destination: ['Luzon', 'Visayas', 'Mindanao', 'Pickup'][i % 4],
    subtotal: 950 + i,
    shippingFee: i % 4 === 3 ? 0 : 180,
    total: 1130 + i,
    paymentMethod: 'gcash',
    paymentStatus: pay[i % 4],
    fulfillmentStatus: ful[i % 5],
    courier: 'J&T Express',
    trackingNumber: 'JT' + i,
    isTest: false,
  }));
}

const API = {
  // The Dashboard's first paint is one consolidated call; the report-only
  // endpoint is still used when a date filter changes.
  '/api/admin-dashboard': () => ({
    orderStats: { pendingReviewCount: 12, paidAwaitingProcessingCount: 8, paidUnfulfilledCount: 5, totalOrdersCount: 1247 },
    ...API['/api/admin-report'](),
    catalogStats: API['/api/admin-catalog-stats'](),
    _timing: { cold: false, uptimeAtStartMs: 1200, authVerifyTokenMs: 40, authStatusReadMs: 55, firestoreConcurrentMs: 180, totalHandlerMs: 280 },
  }),
  '/api/admin-report': () => {
    const orders = makeOrders(14);
    return {
      range: { preset: 'month', startDate: '2026-09-01', endDate: '2026-09-30', label: 'Sep 1, 2026 – Sep 30, 2026', spanDays: 30, generatedAt: 'Sep 3, 2026 1:41 PM (PHT)' },
      includeTest: false,
      summary: {
        totalOrders: 14, paidOrders: 4, awaitingPayment: 3, pendingReview: 4, rejected: 3,
        grossPaidSales: 45820.5, merchandiseSales: 38200, shippingCollected: 7620.5, averagePaidOrderValue: 11455.125,
        paymentBreakdown: { awaiting_payment: 3, pending_review: 4, paid: 4, rejected: 3 },
        fulfillmentBreakdown: { unfulfilled: 3, processing: 3, ready_for_pickup: 3, shipped: 3, completed: 2 },
      },
      orders,
      meta: { testOrdersInRange: 7, fetchedCount: 21, truncated: false, maxOrders: 5000 },
    };
  },
  '/api/admin-order-stats': () => ({ pendingReviewCount: 12, paidAwaitingProcessingCount: 8, paidUnfulfilledCount: 5, totalOrdersCount: 1247 }),
  '/api/admin-catalog-stats': () => ({
    productsActive: 18, productsTotal: 24, patches: 32, collections: 6, outOfStockCount: 3,
    outOfStock: [{ id: 'p1', title: 'Everyday Pouch — Limited Edition Teal' }, { id: 'p2', title: 'Canvas Tote' }, { id: 'p3', title: 'Mini Pouch' }],
  }),
  '/api/admin-list-orders': () => ({ orders: makeOrders(20).map((o) => ({ ...o, createdAt: { _seconds: Math.floor(o.createdAtMs / 1000) } })), nextCursor: 'abc' }),
  '/api/admin-get-order': () => {
    const o = makeOrders(1)[0];
    return {
      order: {
        ...o, customerName: LONG_NAME, customerEmail: LONG_EMAIL,
        deliveryAddress: { line1: '1234 A Very Long Street Name Avenue Extension', line2: 'Unit 5B', barangay: 'Barangay San Antonio de Padua', city: 'Muntinlupa City', province: 'Metro Manila', postalCode: '1771' },
        orderNotes: 'Please handle with care, this is a gift.',
        items: [{ productName: 'Everyday Pouch — Limited Edition', variantName: 'Teal', sku: 'POUCH-TEAL', quantity: 2, pricing: { unitPrice: 475, lineTotal: 950 }, thumbnailUrl: null, customization: null }],
        pricing: { subtotal: 950, shippingFee: 180, total: 1130 },
        paymentAttempts: [
          { attemptId: 'a1', paymentMethod: 'gcash', paymentReference: '9182736450192837', payerName: LONG_NAME, submittedAt: { _seconds: 1788000000 }, status: 'rejected', rejectionCode: 'AMOUNT_MISMATCH', rejectionNote: 'Amount sent was short by 180.' },
          { attemptId: 'a2', paymentMethod: 'gcash', paymentReference: '1029384756574839', payerName: LONG_NAME, submittedAt: { _seconds: 1788003600 }, status: 'pending_review' },
        ],
        history: [{ action: 'created', at: { _seconds: 1788000000 }, actorType: 'customer', actorId: null, meta: {} }, { action: 'payment_submitted', at: { _seconds: 1788003600 }, actorType: 'customer', actorId: null, meta: {} }],
        inventoryStatus: 'locked', paymentStatus: 'pending_review', fulfillmentStatus: 'unfulfilled',
        isTest: false, createdAt: { _seconds: 1788000000 }, updatedAt: { _seconds: 1788003600 },
      },
    };
  },
  '/api/admin-get-settings': () => ({
    role: 'owner', canEditPayment: true,
    shipping: { deliveryEnabled: true, pickupEnabled: true, pickupFee: 0, freeShippingThreshold: null, rates: { luzon: 150, visayas: 180, mindanao: 200 }, ratesSource: 'regional', legacyFlatRateDelivery: null },
    payment: { checkoutEnabled: true, gcash: { enabled: true, accountName: 'Buddy Patches', accountNumber: '09171234567', mobileNumber: '09171234567', bankName: '', instructions: '', qrImagePath: null, qrImageUrl: null, fromLegacy: false }, bank: { enabled: false, accountName: '', accountNumber: '', mobileNumber: '', bankName: '', instructions: '', qrImagePath: null, qrImageUrl: null, fromLegacy: false }, legacyMethods: [], hasNewShape: true },
  }),
  '/api/admin-list-team': () => ({ members: [{ uid: 'u1', email: 'owner@buddypatches.test', displayName: 'Owner Account', role: 'owner', status: 'active', createdAt: { _seconds: 1788000000 } }, { uid: 'u2', email: 'a.very.long.admin.email.address@example.com', displayName: 'Second Admin', role: 'admin', status: 'active', createdAt: { _seconds: 1788000000 } }] }),
};

/* ---------------------------------------------------------------------
   Static server
--------------------------------------------------------------------- */

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];

      const apiKey = Object.keys(API).find((k) => url === k);
      if (apiKey) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(API[apiKey]()));
        return;
      }
      if (url.startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      // Local stub modules, served same-origin.
      //
      // Intercepting the gstatic request in Puppeteer does not work here:
      // a cross-origin ES module import is subject to CORS, and the
      // browser rejects the response before our stub can take effect. So
      // the import SPECIFIER is rewritten below to point at these instead,
      // which keeps everything same-origin and CORS-free.
      if (url === '/__stub/firebase-app.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(FIREBASE_APP_STUB); return;
      }
      if (url === '/__stub/firebase-auth.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(FIREBASE_AUTH_STUB); return;
      }

      let filePath = path.join(ROOT, url === '/' ? 'index.html' : decodeURIComponent(url));
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }

      // Rewrite the Firebase SDK imports in any served JS to the local stubs.
      if (path.extname(filePath) === '.js') {
        const src = fs.readFileSync(filePath, 'utf8')
          .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-app\.js/g, '/__stub/firebase-app.js')
          .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-auth\.js/g, '/__stub/firebase-auth.js');
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(src); return;
      }

      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

/* ---------------------------------------------------------------------
   Run
--------------------------------------------------------------------- */

const PAGES = [
  { name: 'Dashboard', url: '/admin/index.html', wait: '[data-report-metrics]' },
  { name: 'Orders', url: '/admin/orders.html', wait: '[data-order-rows] tr' },
  { name: 'OrderDetail', url: '/admin/order-detail.html?id=ord0', wait: '[data-order-detail]' },
  { name: 'Settings', url: '/admin/settings.html', wait: '[data-settings-body]' },
  { name: 'Team', url: '/admin/team.html', wait: 'body' },
];

async function main() {
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) { console.error('No Chrome/Edge found.'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  const server = await startServer();
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });

  let failures = 0;
  const consoleErrors = [];
  const apiCalls = {};

  console.log('\n=== Admin layout / overflow test (local Chrome, stubbed API) ===');
  console.log('Chrome: ' + chrome + '\n');

  for (const pageDef of PAGES) {
    console.log('--- ' + pageDef.name + ' ---');

    for (const width of [DESKTOP, ...WIDTHS]) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });

      const calls = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${pageDef.name}@${width}: ${m.text()}`); });
      page.on('pageerror', (e) => consoleErrors.push(`${pageDef.name}@${width}: PAGEERROR ${e.message}`));
      // Count real API traffic. Import rewriting happens server-side, so no
      // request interception is needed and nothing can silently swallow a
      // request we are trying to count.
      page.on('request', (r) => { if (r.url().includes('/api/')) calls.push(r.url().split('?')[0].replace(/^.*\/api\//, '')); });

      try {
        await page.goto(`http://localhost:${PORT}${pageDef.url}`, { waitUntil: 'networkidle0', timeout: 20000 });
        await page.waitForSelector(pageDef.wait, { timeout: 8000 }).catch(() => {});
      } catch (e) {
        console.log(`  ${String(width).padStart(4)}px  LOAD FAILED: ${e.message}`);
        failures++;
        await page.close();
        continue;
      }

      if (width === DESKTOP) apiCalls[pageDef.name] = calls.slice();

      const metrics = await page.evaluate(() => {
        const de = document.documentElement;
        const overflowing = [];
        for (const el of document.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > de.clientWidth + 1) {
            overflowing.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className && String(el.className).slice(0, 60)) || '',
              right: Math.round(r.right),
            });
          }
        }
        const sidebar = document.getElementById('admin-sidebar');
        return {
          scrollWidth: de.scrollWidth,
          clientWidth: de.clientWidth,
          bodyScrollWidth: document.body.scrollWidth,
          overflowing: overflowing.slice(0, 4),
          // Proof the app actually booted. An empty page trivially does not
          // overflow, so without this a total render failure reads as a
          // pass — which is exactly what happened on the first run of this
          // script when the Firebase stub was blocked by CORS.
          shellRendered: !!(sidebar && sidebar.children.length > 0),
          mainTextLength: (document.querySelector('.admin-main')?.innerText || '').trim().length,
        };
      });

      // Fail loudly rather than reporting a meaningless pass.
      if (!metrics.shellRendered || metrics.mainTextLength < 40) {
        failures++;
        console.log(`  ${String(width).padStart(4)}px  DID NOT RENDER  (shell=${metrics.shellRendered}, mainText=${metrics.mainTextLength} chars) — overflow result would be meaningless`);
        await page.screenshot({ path: path.join(OUT, `${pageDef.name}-${width}-FAILED.png`) });
        await page.close();
        continue;
      }

      const overflow = metrics.scrollWidth > metrics.clientWidth + 1;
      const tag = width === DESKTOP ? 'desktop' : 'mobile ';
      if (overflow) {
        failures++;
        console.log(`  ${String(width).padStart(4)}px  ${tag}  OVERFLOW  scrollWidth ${metrics.scrollWidth} > clientWidth ${metrics.clientWidth}`);
        for (const o of metrics.overflowing) console.log(`            culprit: <${o.tag} class="${o.cls}"> right=${o.right}`);
      } else {
        console.log(`  ${String(width).padStart(4)}px  ${tag}  OK        no page-level horizontal overflow`);
      }

      await page.screenshot({ path: path.join(OUT, `${pageDef.name}-${width}.png`), fullPage: false });
      await page.close();
    }
    console.log('');
  }

  console.log('=== API calls observed per page (desktop load) ===');
  for (const [name, calls] of Object.entries(apiCalls)) {
    const counts = calls.reduce((a, c) => ((a[c] = (a[c] || 0) + 1), a), {});
    const dupes = Object.entries(counts).filter(([, n]) => n > 1);
    console.log(`  ${name.padEnd(12)} ${calls.length} call(s): ${Object.keys(counts).join(', ') || '(none)'}`);
    if (dupes.length) {
      console.log(`               DUPLICATES: ${dupes.map(([k, n]) => k + ' x' + n).join(', ')}`);
      failures++;
    }
    for (const forbidden of ['admin-list-products', 'admin-list-patches', 'admin-list-collections']) {
      if (counts[forbidden]) { console.log(`               CATALOG LEAK: ${forbidden}`); failures++; }
    }
  }

  console.log('\n=== Console / page errors ===');
  if (!consoleErrors.length) console.log('  none');
  else consoleErrors.slice(0, 15).forEach((e) => console.log('  ' + e));

  await browser.close();
  server.close();

  console.log(`\nScreenshots: .qa-artifacts/layout/`);
  console.log(failures ? `\n${failures} issue(s) found.\n` : '\nAll layout checks passed.\n');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
