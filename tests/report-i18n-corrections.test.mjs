import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translate, translations } from '../lib/translations.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, f), 'utf8');

function tKeysOf(file) {
  const s = src(file);
  const out = new Set();
  for (const m of s.matchAll(/t\(['"`]([A-Za-z0-9_]+)['"`]\)/g)) out.add(m[1]);
  return out;
}

describe('REPORT-I18N - label correction', () => {
  test('A. revenue sub-line uses Items/Extra labels, values untouched', () => {
    const s = src('app/manager/reports/page.js');
    assert.ok(s.includes("t('reportItemsLabel')"), 'Items label via dictionary');
    assert.ok(s.includes("t('reportExtraLabel')"), 'Extra label via dictionary');
    assert.ok(!s.includes('Base ${fmtETB'), 'no hardcoded Base label');
    assert.ok(!s.includes('Components ${fmtETB'), 'no hardcoded Components label');
    assert.ok(s.includes('kpis.baseRevenue ?? 0'), 'base value source unchanged');
    assert.ok(s.includes('kpis.componentRevenue'), 'component value source unchanged');
    assert.equal(translations.en.reportItemsLabel, 'Items');
    assert.equal(translations.en.reportExtraLabel, 'Extra');
    assert.ok(translations.am.reportItemsLabel && translations.am.reportItemsLabel !== 'Items');
    assert.ok(translations.am.reportExtraLabel && translations.am.reportExtraLabel !== 'Extra');
  });

  test('B. Cancelled Items renders below Kitchen & Barista Preparation Speed', () => {
    const s = src('app/manager/reports/page.js');
    const kitchenIdx = s.indexOf('KITCHEN SPEED');
    const cancelledIdx = s.indexOf('CANCELLED ITEMS');
    assert.ok(kitchenIdx !== -1 && cancelledIdx !== -1, 'both sections present');
    assert.ok(kitchenIdx < cancelledIdx, 'Kitchen Speed appears before Cancelled Items');
    assert.equal(
      (s.match(/CANCELLED ITEMS/g) || []).length, 1,
      'Cancelled Items container exists exactly once (moved, not duplicated)'
    );
  });
});

describe('REPORT-I18N - Amharic UI coverage', () => {
  const pages = [
    'app/components/CashierUI.jsx',
    'app/components/StaffManagement.jsx',
    'app/components/InventoryUI.jsx',
  ];

  test('C. every t() key used by the three pages exists in Amharic', () => {
    const missing = [];
    for (const f of pages) {
      for (const k of tKeysOf(f)) {
        if (!translations.am[k]) missing.push(`${f}:${k}`);
      }
    }
    assert.deepEqual(missing, [], `missing Amharic keys: ${missing.join(', ')}`);
  });

  test('D. English restores exact prior copy for sampled keys', () => {
    assert.equal(translate('en', 'cashierTitle'), translations.en.cashierTitle);
    assert.equal(translate('en', 'cashierPrint'), 'Print (browser)');
    assert.equal(translate('en', 'reportItemsLabel'), 'Items');
    assert.equal(translate('en', 'invSave'), 'Save');
    assert.equal(translate('en', 'staffSave'), translations.en.staffSave);
  });

  test('E. Amharic resolves (no English fallback) for new keys', () => {
    for (const k of ['cashierPrint', 'cashierThanks', 'staffActions', 'invAddSupplier', 'reportExtraLabel', 'cashierVoided', 'staffRoleKitchen', 'invOutOfStock']) {
      const v = translate('am', k);
      assert.ok(v && v !== k, `${k} resolves`);
      assert.notEqual(v, translations.en[k], `${k} is not English fallback`);
    }
  });

  test('F. language toggle architecture unchanged', () => {
    const p = src('app/components/LanguageProvider.jsx');
    assert.ok(p.includes("hms_lang"), 'persistence key unchanged');
    assert.ok(p.includes('SUPPORTED_LANGS'), 'supported langs unchanged');
    assert.ok(src('lib/translations.js').includes('translations[lang]?.[key] ?? translations.en[key] ?? key'), 'fallback chain unchanged');
  });

  test('G. no backend/API/database changes in touched UI', () => {
    for (const f of [...pages, 'app/manager/reports/page.js']) {
      const s = src(f);
      assert.ok(!s.includes('createSessionToken') && !s.includes('verifyRolePin'), `${f}: no auth changes`);
    }
    const cashier = src('app/components/CashierUI.jsx');
    assert.ok(cashier.includes("safeFetchJson('/api/brand'"), 'brand uses existing public API');
    assert.ok(!cashier.includes('/api/brand/upload'), 'no brand writes from cashier');
  });
});
