// Station Menu Item Performance (Kitchen / Barista / Jebena Buna) — DB-free
// proofs. The canonical Cashier aggregation is reused, so these tests pin the
// station partition, role-derived authorization, date presets and the
// non-polling UI contract without touching MongoDB.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STATION_REPORT_ROLES,
  stationReportScope,
  buildStationMenuItemPerformance,
  projectStationReportResponse,
} from '../lib/stationReport.js';
import {
  CASHIER_REPORT_INTERVALS,
  parseCashierReportQuery,
} from '../lib/cashierReport.js';
import { ethQuickRanges } from '../lib/ethiopianCalendar.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');

function mixedOrders() {
  return [
    {
      orderNumber: 'A1',
      status: 'PAID',
      items: [
        { lineId: 'f1', name: 'Burger', type: 'FOOD', price: 100, quantity: 2 },
        { lineId: 'd1', name: 'Soda', type: 'DRINK', price: 50, quantity: 1 },
        { lineId: 'h1', name: 'Buna', type: 'HOT_DRINK', price: 30, quantity: 3 },
        { lineId: 'x1', name: 'Void', type: 'FOOD', price: 999, quantity: 1, cancelled: true },
      ],
    },
    {
      orderNumber: 'A2',
      status: 'READY',
      items: [
        { lineId: 'f2', name: 'Burger', type: 'FOOD', price: 100, quantity: 1 },
        // Legacy line: no `type`, only categoryType -> canonical fallback.
        { lineId: 'd2', name: 'Soda', categoryType: 'DRINK', price: 50, quantity: 2 },
      ],
    },
    {
      orderNumber: 'A3',
      status: 'SERVED',
      items: [{ lineId: 'h2', name: 'Buna', type: 'HOT_DRINK', price: 30, quantity: 1 }],
    },
    {
      orderNumber: 'A4',
      status: 'PAYMENT_PENDING',
      items: [{ lineId: 'f3', name: 'Burger', type: 'FOOD', price: 100, quantity: 5 }],
    },
    {
      orderNumber: 'A5',
      status: 'PENDING',
      items: [{ lineId: 'h3', name: 'Buna', type: 'HOT_DRINK', price: 30, quantity: 5 }],
    },
    {
      orderNumber: 'A6',
      status: 'PAID',
      items: [
        // Empty `type` is NOT nullish, so canonical routing rejects it even
        // though categoryType is present (same rule as the Cashier report).
        { lineId: 'd3', name: 'Type conflict', type: '', categoryType: 'DRINK', price: 25, quantity: 1 },
      ],
    },
  ];
}

describe('station report scope (role -> station -> item type)', () => {
  test('maps each station role to exactly one item type', () => {
    assert.deepEqual(stationReportScope('KITCHEN'), { station: 'KITCHEN', itemType: 'FOOD' });
    assert.deepEqual(stationReportScope('BARISTA'), { station: 'BARISTA', itemType: 'DRINK' });
    assert.deepEqual(stationReportScope('HOT_DRINK'), { station: 'HOT_DRINK', itemType: 'HOT_DRINK' });
  });

  test('non-station roles never receive a station scope', () => {
    for (const role of ['CASHIER', 'MANAGER', 'WAITER', 'HOTEL_MANAGER', '', null, undefined]) {
      assert.equal(stationReportScope(role), null, String(role));
    }
  });

  test('the endpoint allowlist contains only the three station roles', () => {
    assert.deepEqual([...STATION_REPORT_ROLES], ['KITCHEN', 'BARISTA', 'HOT_DRINK']);
  });
});

describe('station menu-item isolation', () => {
  test('Kitchen receives only FOOD rows', () => {
    const rows = buildStationMenuItemPerformance(mixedOrders(), 'FOOD');
    assert.deepEqual(rows.map((row) => row.name), ['Burger']);
    assert.equal(rows[0].category, 'FOOD');
  });

  test('Barista receives only DRINK rows', () => {
    const rows = buildStationMenuItemPerformance(mixedOrders(), 'DRINK');
    assert.deepEqual(rows.map((row) => row.name), ['Soda']);
    assert.equal(rows[0].category, 'DRINK');
  });

  test('Jebena Buna receives only HOT_DRINK rows', () => {
    const rows = buildStationMenuItemPerformance(mixedOrders(), 'HOT_DRINK');
    assert.deepEqual(rows.map((row) => row.name), ['Buna']);
    assert.equal(rows[0].category, 'HOT_DRINK');
  });

  test('the same name in two item types stays two station-scoped rows', () => {
    const cross = [
      {
        orderNumber: 'C1',
        status: 'PAID',
        items: [
          { lineId: 'a', name: 'Special', type: 'FOOD', price: 10, quantity: 1 },
          { lineId: 'b', name: 'Special', type: 'DRINK', price: 20, quantity: 1 },
        ],
      },
    ];
    const food = buildStationMenuItemPerformance(cross, 'FOOD');
    const drink = buildStationMenuItemPerformance(cross, 'DRINK');
    assert.equal(food.length, 1);
    assert.equal(drink.length, 1);
    assert.equal(food[0].paidRevenue, 10);
    assert.equal(drink[0].paidRevenue, 20);
  });

  test('unknown item types return no rows', () => {
    assert.deepEqual(buildStationMenuItemPerformance(mixedOrders(), 'DESSERT'), []);
    assert.deepEqual(buildStationMenuItemPerformance(mixedOrders(), ''), []);
  });
});

describe('station quantity, distinct-order and revenue rules', () => {
  const food = buildStationMenuItemPerformance(mixedOrders(), 'FOOD')[0];
  const drink = buildStationMenuItemPerformance(mixedOrders(), 'DRINK')[0];
  const hot = buildStationMenuItemPerformance(mixedOrders(), 'HOT_DRINK')[0];

  test('quantity sold sums qualifying quantities', () => {
    assert.equal(food.units, 3); // PAID 2 + READY 1
    assert.equal(drink.units, 3); // PAID 1 + READY 2 (legacy categoryType line)
    assert.equal(hot.units, 4); // PAID 3 + SERVED 1
  });

  test('orders counts distinct order IDs, not item lines', () => {
    assert.equal(food.orderCount, 2); // A1 + A2
    assert.equal(drink.orderCount, 2); // A1 + A2
    assert.equal(hot.orderCount, 2); // A1 + A3
  });

  test('revenue uses persisted historical line amounts for PAID orders only', () => {
    assert.equal(food.paidRevenue, 200); // A1: 100 * 2
    assert.equal(drink.paidRevenue, 50); // A1: 50 * 1
    assert.equal(hot.paidRevenue, 90); // A1: 30 * 3
  });

  test('cancelled, pending, payment-pending and type-conflict lines never count', () => {
    const names = new Set([
      ...buildStationMenuItemPerformance(mixedOrders(), 'FOOD'),
      ...buildStationMenuItemPerformance(mixedOrders(), 'DRINK'),
      ...buildStationMenuItemPerformance(mixedOrders(), 'HOT_DRINK'),
    ].map((row) => row.name));
    assert.equal(names.has('Void'), false);
    assert.equal(names.has('Type conflict'), false);
    // PENDING / PAYMENT_PENDING quantities (5 each) never inflate the counts.
    assert.equal(food.units, 3);
    assert.equal(hot.units, 4);
  });
});

describe('station response projection', () => {
  const from = new Date('2026-10-01T00:00:00.000Z');
  const to = new Date('2026-10-08T00:00:00.000Z');
  const response = projectStationReportResponse({
    station: 'KITCHEN',
    itemType: 'FOOD',
    from,
    to,
    interval: 'last7',
    orders: mixedOrders(),
  });

  test('returns only the station rows and a station-scoped total', () => {
    assert.deepEqual(Object.keys(response).sort(), ['itemType', 'menuItems', 'range', 'station', 'totals']);
    assert.equal(response.station, 'KITCHEN');
    assert.equal(response.itemType, 'FOOD');
    assert.equal(response.menuItems.length, 1);
    assert.equal(response.totals.items, 1);
    assert.equal(response.totals.units, 3);
    assert.equal(response.totals.revenue, 200);
    assert.equal(response.range.from, from.toISOString());
    assert.equal(response.range.to, to.toISOString());
    assert.equal(response.range.interval, 'last7');
  });

  test('does not leak other stations or raw orders', () => {
    const json = JSON.stringify(response);
    assert.equal(json.includes('Soda'), false);
    assert.equal(json.includes('Buna'), false);
    assert.equal(json.includes('"orders"'), false);
  });
});

describe('station report date presets reuse the canonical Cashier window', () => {
  const now = new Date('2026-11-01T12:00:00.000Z');
  const ranges = ethQuickRanges(now);

  test('every Cashier preset resolves through parseCashierReportQuery', () => {
    assert.deepEqual([...CASHIER_REPORT_INTERVALS], ['today', 'yesterday', 'thisWeek', 'thisMonth', 'last7']);
    for (const key of CASHIER_REPORT_INTERVALS) {
      assert.ok(ranges[key], `missing quick range ${key}`);
      const parsed = parseCashierReportQuery(
        new URLSearchParams({ from: ranges[key].from, to: ranges[key].to, interval: key }),
        now
      );
      assert.equal(parsed.ok, true, key);
      assert.equal(parsed.interval, key);
      assert.ok(parsed.from.getTime() < parsed.to.getTime(), `${key} must be a positive window`);
    }
  });

  test('invalid intervals and oversized ranges are rejected consistently', () => {
    assert.equal(parseCashierReportQuery(new URLSearchParams({ interval: 'bogus' }), now).ok, false);
    assert.equal(
      parseCashierReportQuery(new URLSearchParams({ from: '2026-01-01', to: '2026-02-01' }), now).ok,
      false
    );
  });
});

describe('station report endpoint authorization contract', () => {
  const api = src('app/api/station/report/route.js');

  test('authenticates and derives the station from the session role', () => {
    assert.ok(api.includes('requireAuth(request, STATION_ROLES)'));
    assert.ok(api.includes('stationReportScope(auth.payload.role)'));
    assert.ok(api.includes('const STATION_ROLES = ["KITCHEN", "BARISTA", "HOT_DRINK"]'));
  });

  test('never reads a client station/role/dest parameter', () => {
    assert.equal(api.includes('get("station")'), false);
    assert.equal(api.includes('get("role")'), false);
    assert.equal(api.includes('get("dest")'), false);
    assert.equal(api.includes('searchParams.get("station")'), false);
  });

  test('reuses the canonical date parser and a bounded, projected query', () => {
    assert.ok(api.includes('parseCashierReportQuery'));
    assert.ok(api.includes('.select("orderNumber status items")'));
    assert.ok(api.includes('status: { $in: FULFILLED_STATUSES }'));
    assert.ok(api.includes('createdAt: { $gte: from, $lt: to }'));
    assert.ok(api.includes('.lean()'));
  });
});

describe('station report UI contract', () => {
  const panel = src('app/components/StationReportPanel.jsx');
  const board = src('app/components/KitchenDisplay.js');

  test('uses the same five presets and canonical range helper as Cashier', () => {
    for (const key of ['today', 'yesterday', 'thisWeek', 'thisMonth', 'last7']) {
      assert.ok(panel.includes(`key: '${key}'`), key);
    }
    assert.ok(panel.includes('ethQuickRanges()'));
    assert.ok(panel.includes('addisYMDToUTCStart'));
    assert.ok(panel.includes('/api/station/report?'));
  });

  test('fetches only when opened, on preset change, or on explicit refresh', () => {
    assert.ok(panel.includes('if (next && !data && !loading) fetchReport(range, preset)'));
    assert.ok(panel.includes('fetchReport(nextRange, key)'));
    assert.equal(panel.includes('setInterval'), false);
    assert.equal(panel.includes('EventSource'), false);
    assert.equal(panel.includes('useOrderEvents'), false);
    assert.equal(panel.includes('/api/auth/me'), false);
  });

  test('prevents duplicate/obsolete requests', () => {
    assert.ok(panel.includes('AbortController'));
    assert.ok(panel.includes('reqIdRef.current'));
    assert.ok(panel.includes('previous?.abort()'));
    assert.ok(panel.includes('setData(null)'), 'changing interval clears stale rows');
  });

  test('has loading, empty, error and retry states', () => {
    assert.ok(panel.includes('animate-pulse'));
    assert.ok(panel.includes('copy.empty'));
    assert.ok(panel.includes('role="alert"'));
    assert.ok(panel.includes("t('uiRetry')"));
    assert.ok(panel.includes('copy.dbUnavailable'));
  });

  test('is mounted on the shared station board without touching its workflow', () => {
    assert.ok(board.includes('<StationReportPanel itemType={station} stationName={title} />'));
    assert.ok(board.includes("import StationReportPanel from '@/app/components/StationReportPanel'"));
    // Preparation workflow remains intact.
    assert.ok(board.includes("updateOrder(order._id, 'PREPARING')"));
    assert.ok(board.includes("updateOrder(order._id, 'READY', order.waiterInfo)"));
  });
});

describe('Cashier report remains unchanged', () => {
  test('its endpoint still authorizes CASHIER and projects the same contract', () => {
    const route = src('app/api/cashier/report/route.js');
    assert.ok(route.includes('requireAuth(request, ["CASHIER"])'));
    assert.ok(route.includes('projectCashierReportResponse'));
    assert.ok(route.includes('parseCashierReportQuery'));
    assert.ok(route.includes('getReport(conn, { from, to, prevFrom, interval }'));
  });

  test('its UI still calls /api/cashier/report', () => {
    const ui = src('app/components/CashierUI.jsx');
    assert.ok(ui.includes('/api/cashier/report?'));
    assert.ok(ui.includes('MenuItemGroup'));
  });
});
