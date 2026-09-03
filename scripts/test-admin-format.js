/*
 * OFFLINE TEST — admin display formatting.
 *
 * Exists because of a real bug: fmtMoney appended '.00' to
 * toLocaleString(), which only worked while every money value was a whole
 * number. Phase 5D.3 introduced the first fractional one (average paid
 * order value) and it rendered as "₱11,455.125.00" on the dashboard while
 * the Excel/PDF exports printed "₱11,455.13" for the same figure.
 *
 * admin-format.js is an ES module for the browser, so the formatter is
 * re-implemented here from the module source rather than imported, keeping
 * this runnable under plain node with no build step.
 *
 * Usage: node scripts/test-admin-format.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'admin', 'js', 'admin-format.js'), 'utf8');

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

// Pull the live fmtMoney body out of the module so this tests the real code.
const match = /export function fmtMoney\(n\) \{([\s\S]*?)\n\}/.exec(SRC);
if (!match) {
  console.error('Could not locate fmtMoney in admin-format.js');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const fmtMoney = new Function('n', match[1]);

// The exports' own formatter, for parity comparison.
const exportMoney = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

console.log('\n=== fmtMoney ===');

test('whole numbers unchanged from the previous behaviour', () => {
  assert.strictEqual(fmtMoney(1130), '₱1,130.00');
  assert.strictEqual(fmtMoney(950), '₱950.00');
  assert.strictEqual(fmtMoney(0), '₱0.00');
});

test('REGRESSION: a fractional value renders correctly, not with a doubled decimal', () => {
  assert.strictEqual(fmtMoney(45820.5), '₱45,820.50');
  assert.ok(!fmtMoney(45820.5).includes('.5.00'), 'must not produce "₱45,820.5.00"');
});

test('REGRESSION: a repeating average rounds to two decimals', () => {
  assert.strictEqual(fmtMoney(11455.125), '₱11,455.13');
  assert.ok(!/\.\d{3}/.test(fmtMoney(11455.125)), 'must never show three decimal places');
});

test('never emits two decimal points', () => {
  for (const v of [0, 1, 1130, 45820.5, 11455.125, 999999.999, 0.005]) {
    const out = fmtMoney(v);
    assert.strictEqual((out.match(/\./g) || []).length, 1, `two decimal points in ${out}`);
  }
});

test('dashboard formatting matches the Excel/PDF formatter exactly', () => {
  // This is the parity the brief requires: the same figure must read the
  // same on screen and in the downloaded report.
  for (const v of [0, 950, 1130, 45820.5, 11455.125, 38200, 7620.5]) {
    assert.strictEqual(fmtMoney(v), exportMoney(v), `mismatch at ${v}`);
  }
});

test('null/undefined/NaN degrade to zero rather than "₱NaN"', () => {
  assert.strictEqual(fmtMoney(null), '₱0.00');
  assert.strictEqual(fmtMoney(undefined), '₱0.00');
  assert.strictEqual(fmtMoney(NaN), '₱0.00');
});

console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' — WITH FAILURES ABOVE' : ' — all green') + '\n');
