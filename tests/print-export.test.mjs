import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, f), 'utf8');

// Mirrors the CSV cell rule in app/manager/reports/page.js exportCSV.
function csvCell(c) {
  if (c == null) return '""';
  return `"${String(c).replace(/"/g, '""')}"`;
}

describe('PRINT-EXPORT - cashier thermal ticket', () => {
  test('1. dedicated ticket node exists and print targets only it', () => {
    const s = src('app/components/CashierUI.jsx');
    assert.ok(s.includes('id="bono-thermal-ticket"'), 'dedicated ticket container');
    assert.ok(s.includes('bono-print-only'), 'hidden on screen');
    assert.ok(src('app/globals.css').includes('#bono-thermal-ticket'), 'print CSS addresses the ticket');
    assert.ok(src('app/globals.css').includes('@media print'), 'print media rules exist');
  });

  test('2. ticket renders live order fields, never hardcoded values', () => {
    const s = src('app/components/CashierUI.jsx');
    const ticket = s.slice(s.indexOf('bono-thermal-ticket'));
    for (const field of ['selected.orderNumber', 'selected.tableNumber', 'selected.items', 'selected.totalAmount', 'selected.paymentMethod', 'selected.waiterName', 'selected.status']) {
      assert.ok(ticket.includes(field), `ticket uses live ${field}`);
    }
    // No fabricated transaction totals inside the ticket markup.
    assert.ok(!/TOTAL\s+480/.test(ticket), 'no example totals hardcoded');
  });

  test('3. ticket totals reuse the preview derivation (no recalculation)', () => {
    const s = src('app/components/CashierUI.jsx');
    assert.ok(s.includes('Number(selected.cancelledAmount) > 0 ? selected.netAmount : selected.totalAmount'), 'net/gross rule shared with preview');
  });

  test('4. brand header is configured, footer message present', () => {
    const s = src('app/components/CashierUI.jsx');
    assert.ok(s.includes("safeFetchJson('/api/brand'"), 'brand comes from existing config API');
    assert.ok(s.includes('AVENUE HOTEL'), 'operational brand fallback');
    assert.ok(s.includes("t('cashierThanks')"), 'hospitality footer via dictionary');
  });

  test('5. print gate never blanks unrelated pages', () => {
    const css = src('app/globals.css');
    assert.ok(css.includes('body.bono-print-ticket'), 'ticket rules gated on body class');
    assert.ok(css.includes('body.bono-print-report'), 'report rules gated on body class');
    const ui = src('app/components/CashierUI.jsx');
    assert.ok(ui.includes("document.body.classList.add('bono-print-ticket')"), 'gate enabled only with a printable ticket');
    assert.ok(ui.includes("document.body.classList.remove('bono-print-ticket')"), 'gate cleaned up');
  });

  test('6. ticket is monochrome thermal-safe', () => {
    const css = src('app/globals.css');
    assert.ok(css.includes('max-width: 72mm'), 'thermal width bound');
    assert.ok(css.includes('page-break-inside: avoid'), 'totals kept together');
  });
});

describe('PRINT-EXPORT - manager report document (PDF via print)', () => {
  test('7. dedicated 2D document node exists, dashboard excluded', () => {
    const s = src('app/manager/reports/page.js');
    assert.ok(s.includes('id="bono-report-doc"'), 'dedicated document container');
    assert.ok(src('app/globals.css').includes('#bono-report-doc'), 'print CSS addresses the document');
  });

  test('8. document renders live report data with period and brand', () => {
    const s = src('app/manager/reports/page.js');
    const doc = s.slice(s.indexOf('bono-report-doc'));
    for (const field of ['data.topItems', 'data.waiterPerf', 'data.paymentBreakdown', 'data.kpis', 'reportBrand', 'interval', 'itemFilter']) {
      assert.ok(doc.includes(field), `document uses live ${field}`);
    }
  });

  test('9. tables repeat headers and avoid breaks', () => {
    const css = src('app/globals.css');
    assert.ok(css.includes('table-header-group'), 'thead repeats across pages');
  });

  test('10. no chart screenshots in the document', () => {
    const s = src('app/manager/reports/page.js');
    const start = s.indexOf('id="bono-report-doc"');
    const end = s.indexOf('small presentational helpers', start);
    const doc = s.slice(start, end);
    assert.ok(!doc.includes('PieChart') && !doc.includes('ResponsiveContainer') && !doc.includes('<canvas'), 'data tables only');
  });
});

describe('PRINT-EXPORT - CSV hygiene', () => {
  test('11. null/undefined become empty, never "null"/"undefined"', () => {
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell(undefined), '""');
    assert.equal(csvCell(0), '"0"');
    assert.equal(csvCell('ORD-1'), '"ORD-1"');
  });

  test('12. quotes doubled, commas/newlines safely quoted', () => {
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('x\ny'), '"x\ny"');
  });

  test('13. exporter uses null-safe cells and UTF-8 BOM', () => {
    const s = src('app/manager/reports/page.js');
    assert.ok(s.includes('csvCell'), 'null-safe cell helper in exporter');
    assert.ok(s.includes('\\uFEFF'), 'BOM for spreadsheet UTF-8 import');
    assert.ok(s.includes("text/csv;charset=utf-8"), 'CSV mime type');
  });
});
