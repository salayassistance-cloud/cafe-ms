import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translate, translations } from '../lib/translations.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, f), 'utf8');

const KEYS = [
  'transferByAccount',
  'transferBank',
  'transferOwner',
  'transferAccount',
  'transferTransactions',
  'transferUnknown',
];

describe('TRANSFER-BY-ACCOUNT - report localization', () => {
  test('A. every transfer label exists in Amharic and is not the English fallback', () => {
    for (const key of KEYS) {
      assert.ok(translations.am[key], `${key} present in Amharic`);
      assert.notEqual(translations.am[key], translations.en[key], `${key} translated in Amharic`);
      assert.ok(translations.om[key], `${key} present in Oromo`);
    }
    assert.equal(translate('am', 'transferByAccount'), translations.am.transferByAccount);
    assert.equal(translate('en', 'transferByAccount'), 'Transfer by Account');
  });

  test('B. screen table and print document both use translation keys', () => {
    const s = src('app/manager/reports/page.js');
    assert.ok(s.includes("<Section title={t('transferByAccount')}>"), 'screen section title localized');
    assert.ok(s.includes("<h2>{t('transferByAccount')}</h2>"), 'print section title localized');
    for (const key of ['transferBank', 'transferOwner', 'transferAccount', 'transferTransactions', 'revenue']) {
      const count = (s.match(new RegExp(`\\{t\\('${key}'\\)\\}`, 'g')) || []).length;
      assert.ok(count >= 2, `${key} used in both screen and print tables`);
    }
    const unknownFallbacks = (s.match(/a\.bankName \|\| t\('transferUnknown'\)/g) || []).length;
    assert.equal(unknownFallbacks, 2, 'unknown bank fallback localized in screen and print');
    assert.ok(!s.includes('>Transfer by Account<'), 'no hardcoded transfer title');
    for (const header of ['Bank', 'Owner', 'Account', 'Transactions', 'Revenue']) {
      assert.ok(!s.includes(`>${header}</th>`), `no hardcoded ${header} header`);
    }
  });
});
