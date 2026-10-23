import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLocalizedSingleString } from '../lib/displayName.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, f), 'utf8');

describe('MENU-NAME-LANGUAGE - display only', () => {
  test('A. selected language picks the existing name variant without mutating it', () => {
    const name = Object.freeze({ am: 'ዶሮ ወጥ', en: 'Doro Wot', om: 'Doro Wotii' });
    assert.equal(getLocalizedSingleString(name, 'am'), 'ዶሮ ወጥ');
    assert.equal(getLocalizedSingleString(name, 'en'), 'Doro Wot');
    assert.equal(getLocalizedSingleString(name, 'om'), 'Doro Wotii');
    assert.deepEqual({ ...name }, { am: 'ዶሮ ወጥ', en: 'Doro Wot', om: 'Doro Wotii' });
  });

  test('B. plain string snapshots are preserved and missing variants fall back', () => {
    assert.equal(getLocalizedSingleString('Legacy Item', 'en'), 'Legacy Item');
    assert.equal(getLocalizedSingleString({ am: 'ልዩ እቃ' }, 'en'), 'ልዩ እቃ');
    assert.equal(getLocalizedSingleString(null, 'en'), '');
  });

  test('C. shared menu surfaces pass the selected language at render time', () => {
    const menu = src('app/menu/page.js');
    assert.ok(menu.includes('getLocalizedSingleString(item?.name, lang)'), 'menu page reads name by selected language');
    assert.ok(menu.includes('{localizedName(item, lang)}'), 'menu page renders localized name');

    const waiter = src('app/components/WaiterUI.js');
    assert.ok(waiter.includes('getLocalizedSingleString(it.name, lang)'), 'waiter order/name display uses language');
    assert.ok(waiter.includes('getLocalizedSingleString(it.title, lang)'), 'waiter title fallback uses language');
    assert.ok(waiter.includes('{localizedName(item, lang)}'), 'waiter menu/cart renders localized name');

    const kds = src('app/components/KitchenDisplay.js');
    assert.ok(kds.includes('getLocalizedSingleString(it.name, lang)'), 'KDS line display uses language');

    for (const f of ['app/menu/page.js', 'app/components/WaiterUI.js', 'app/components/KitchenDisplay.js']) {
      const s = src(f);
      assert.ok(
        !/getLocalizedSingleString\(\s*(?:it|item)\??\.(?:name|title)\s*\)/.test(s),
        `${f}: no item name display omits the selected language`
      );
      assert.ok(!s.includes('it.name =') && !s.includes('item.name ='), `${f}: name data is not mutated for display`);
    }
  });
});
