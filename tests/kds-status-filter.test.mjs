import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterOrdersByStationStatus } from '../lib/stationStatus.js';
import { SUPPORTED_LANGS, translate } from '../lib/translations.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, f), 'utf8');

function order(id, kitchenStatus, baristaStatus, status = 'PREPARING') {
  return {
    _id: id,
    status,
    kitchenStatus,
    baristaStatus,
    items: [{ type: 'FOOD' }, { type: 'DRINK' }],
  };
}

const ids = (list) => list.map((o) => o._id);

describe('KDS status-card filtering', () => {
  const orders = [
    order('pending', 'PENDING', 'PREPARING', 'PREPARING'),
    order('preparing', 'PREPARING', 'READY', 'PREPARING'),
    order('ready', 'READY', 'PENDING', 'READY'),
    order('missing', null, null, 'READY'),
  ];

  test('A. kitchen filters by kitchenStatus only', () => {
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'KITCHEN', 'PENDING')), ['pending', 'missing']);
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'KITCHEN', 'PREPARING')), ['preparing']);
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'KITCHEN', 'READY')), ['ready']);
  });

  test('B. barista filters by baristaStatus only (same shared component)', () => {
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'BARISTA', 'PENDING')), ['ready', 'missing']);
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'BARISTA', 'PREPARING')), ['pending']);
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'BARISTA', 'READY')), ['preparing']);
  });

  test('C. All Orders keeps every visible order regardless of status', () => {
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'KITCHEN', 'ALL')), ids(orders));
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'BARISTA', 'ALL')), ids(orders));
  });

  test('D. no filter / unknown filter keeps every visible order', () => {
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'KITCHEN', null)), ids(orders));
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'KITCHEN', undefined)), ids(orders));
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'KITCHEN', '')), ids(orders));
    assert.deepEqual(ids(filterOrdersByStationStatus(orders, 'KITCHEN', 'UNKNOWN')), ids(orders));
  });

  test('E. All Orders is selected by default and rendered alongside the status cards', () => {
    const s = src('app/components/KitchenDisplay.js');
    assert.ok(s.includes("const [statusFilter, setStatusFilter] = useState('ALL')"), 'All Orders is selected on load');
    assert.ok(
      s.includes("status: 'ALL', label: t('allOrders'), count: visibleOrders.length"),
      'All Orders card shows the full visible count'
    );
    const allIndex = s.indexOf("{ status: 'ALL'");
    const pendingIndex = s.indexOf("{ status: 'PENDING'");
    assert.ok(allIndex > -1 && pendingIndex > allIndex, 'All Orders card precedes the status cards');
  });

  test('F. status cards filter the board and All Orders clears the filter', () => {
    const s = src('app/components/KitchenDisplay.js');
    assert.ok(
      s.includes("filterOrdersByStationStatus(visibleOrders, summaryStation, statusFilter)"),
      'uses the canonical station-status helper (no duplicate filter logic)'
    );
    assert.ok(s.includes('aria-pressed={active}'), 'selected card is announced');
    assert.ok(
      s.includes("onClick={() => setStatusFilter((current) => (current === card.status ? 'ALL' : card.status))}"),
      'clicking a card selects it; clicking the active status returns to All Orders'
    );
    assert.ok(s.includes("onClick={() => setStatusFilter('ALL')}"), 'empty-state reset restores All Orders');
    assert.ok(s.includes('{filteredOrders.map((o, i) => renderTicket(o, i))}'), 'board renders filtered tickets');
  });

  test('G. counts stay on the full visible board and remain station-scoped', () => {
    const s = src('app/components/KitchenDisplay.js');
    assert.ok(s.includes('for (const o of visibleOrders)'), 'counts iterate the full visible board');
    assert.ok(
      s.includes("const st = summaryStation ? stationStatusOf(o, summaryStation) : (o.status || 'PENDING');"),
      'status counts use the station-scoped status helper'
    );
    assert.ok(!s.includes('for (const o of filteredOrders)'), 'counts are not reduced by the filter');
    assert.ok(
      s.includes("view === 'ALL' ? true : o.items.some((it) => it.type === view && !it.cancelled)"),
      'each station still sees only its eligible order lines'
    );
  });

  test('H. the All Orders label uses the project localization system', () => {
    assert.equal(translate('en', 'allOrders'), 'All Orders');
    assert.equal(translate('am', 'allOrders'), 'ሁሉም ትዕዛዞች');
    assert.equal(translate('om', 'allOrders'), 'Ajajoota Hunda');
    for (const lang of SUPPORTED_LANGS) {
      const label = translate(lang, 'allOrders');
      assert.ok(label && label !== 'allOrders', `${lang} has an allOrders translation`);
    }
    assert.ok(src('app/components/KitchenDisplay.js').includes("t('allOrders')"), 'KDS renders the localized label');
  });
});
