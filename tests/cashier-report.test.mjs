import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { activeItemAmount, buildReport } from '../lib/analytics.js';
import {
  CASHIER_MAX_REPORT_DAYS,
  CASHIER_REPORT_INTERVALS,
  buildCashierMenuItemPerformance,
  normalizeCashierInterval,
  parseCashierReportQuery,
  projectCashierReportResponse,
} from '../lib/cashierReport.js';
import { ethQuickRanges } from '../lib/ethiopianCalendar.js';
import { checkRateLimit, retryAfterSeconds } from '../lib/rateLimit.js';
import { getReport } from '../lib/reportService.js';
import { resolveItemType } from '../lib/reportRevenueBreakdown.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (file) => readFileSync(join(root, file), 'utf8');
const DAY_MS = 24 * 3600 * 1000;

describe('Cashier report canonical helper regression', () => {
  test('canonical item type resolution retains trim/nullish behavior', () => {
    assert.equal(resolveItemType({ type: ' food ' }), 'FOOD');
    assert.equal(resolveItemType({ categoryType: 'drink' }), 'DRINK');
    assert.equal(resolveItemType({ type: null, categoryType: 'FOOD' }), 'FOOD');
    assert.equal(resolveItemType({ type: '', categoryType: 'DRINK' }), null);
    assert.equal(resolveItemType({ type: 'OTHER' }), null);
    assert.equal(resolveItemType(null), null);
  });

  test('canonical active item amount retains priced-component fallback behavior', () => {
    assert.equal(activeItemAmount({ price: 100, quantity: 2 }), 200);
    assert.equal(activeItemAmount({
      price: 100,
      quantity: 1,
      components: [{ kind: 'PRICED_COMPONENT', lineSum: 0, quantity: 2, unitPrice: 25 }],
    }), 150);
    assert.equal(activeItemAmount({
      price: 100,
      quantity: 1,
      components: [{ kind: 'NOTE', note: 'no onion' }],
    }), 100);
  });

  test('canonical report totals and category attribution remain unchanged', () => {
    const from = new Date('2026-10-20T00:00:00.000Z');
    const to = new Date('2026-10-21T00:00:00.000Z');
    const report = buildReport([{
      _id: 'canonical-regression',
      status: 'PAID',
      totalAmount: 300,
      paymentMethod: 'CASH',
      createdAt: new Date('2026-10-20T10:00:00.000Z'),
      items: [
        { name: 'Food', type: 'FOOD', price: 100, quantity: 1 },
        { name: 'Drink', type: 'DRINK', price: 150, quantity: 1 },
        {
          name: 'Extra',
          type: 'FOOD',
          price: 0,
          quantity: 1,
          components: [{ kind: 'PRICED_COMPONENT', lineSum: 0, quantity: 2, unitPrice: 25 }],
        },
      ],
    }], from, to, 'daily');

    assert.equal(report.kpis.revenue, 300);
    assert.equal(report.kpis.foodRevenue, 150);
    assert.equal(report.kpis.drinkRevenue, 150);
    assert.equal(report.kpis.unattributedItemRevenue, 0);
  });
});

describe('Cashier report range validation', () => {
  const now = new Date('2026-10-23T09:00:00.000Z');

  test('accepts all five preset intervals and preserves Addis half-open windows', () => {
    const ranges = ethQuickRanges(now);
    for (const key of CASHIER_REPORT_INTERVALS) {
      const range = ranges[key];
      const parsed = parseCashierReportQuery(
        new URLSearchParams({ from: range.from, to: range.to, interval: key }),
        now
      );
      assert.equal(parsed.ok, true, key);
      assert.equal(parsed.interval, key);
      assert.ok(parsed.from instanceof Date);
      assert.ok(parsed.to instanceof Date);
      assert.ok(parsed.to.getTime() > parsed.from.getTime());
      assert.ok(parsed.to.getTime() - parsed.from.getTime() <= CASHIER_MAX_REPORT_DAYS * DAY_MS);
    }

    const today = parseCashierReportQuery(
      new URLSearchParams({ from: ranges.today.from, to: ranges.today.to }),
      now
    );
    assert.equal(today.ok, true);
    assert.equal(today.interval, 'daily');
    assert.ok(today.to.getTime() > today.from.getTime());
  });

  test('normalizes allowed interval variants and rejects unknown values', () => {
    assert.equal(normalizeCashierInterval(' THISWEEK '), 'thisWeek');
    assert.equal(normalizeCashierInterval('last7'), 'last7');
    assert.equal(normalizeCashierInterval('monthly'), null);

    const parsed = parseCashierReportQuery(
      new URLSearchParams({ from: '2026-01-01', to: '2026-01-02', interval: ' THISWEEK ' }),
      now
    );
    assert.equal(parsed.ok, true);
    assert.equal(parsed.interval, 'thisWeek');

    const unknown = parseCashierReportQuery(
      new URLSearchParams({ from: '2026-01-01', to: '2026-01-02', interval: 'monthly' }),
      now
    );
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 400);
    assert.match(unknown.error, /interval/i);

    const empty = parseCashierReportQuery(
      new URLSearchParams({ from: '2026-01-01', to: '2026-01-02', interval: '' }),
      now
    );
    assert.equal(empty.ok, false);
    assert.equal(empty.status, 400);
  });

  test('rejects invalid dates, inverted ranges, and ranges over 31 days', () => {
    const invalidFrom = parseCashierReportQuery(
      new URLSearchParams({ from: '2026-02-30', to: '2026-03-01' }),
      now
    );
    assert.equal(invalidFrom.ok, false);
    assert.match(invalidFrom.error, /from date/i);

    const invalidTo = parseCashierReportQuery(
      new URLSearchParams({ from: '2026-01-01', to: '2026-13-01' }),
      now
    );
    assert.equal(invalidTo.ok, false);
    assert.match(invalidTo.error, /to date/i);

    const inverted = parseCashierReportQuery(
      new URLSearchParams({ from: '2026-03-02', to: '2026-03-01' }),
      now
    );
    assert.equal(inverted.ok, false);
    assert.match(inverted.error, /date range/i);

    const max = parseCashierReportQuery(
      new URLSearchParams({ from: '2026-01-01', to: '2026-01-31' }),
      now
    );
    assert.equal(max.ok, true);
    assert.equal(max.to.getTime() - max.from.getTime(), 31 * DAY_MS);

    const tooLarge = parseCashierReportQuery(
      new URLSearchParams({ from: '2026-01-01', to: '2026-02-01' }),
      now
    );
    assert.equal(tooLarge.ok, false);
    assert.match(tooLarge.error, /too large/i);
  });

  test('uses an inclusive business day as a one-day half-open window', () => {
    const parsed = parseCashierReportQuery(
      new URLSearchParams({ from: '2026-01-01', to: '2026-01-01' }),
      now
    );
    assert.equal(parsed.ok, true);
    assert.equal(parsed.to.getTime() - parsed.from.getTime(), DAY_MS);
    assert.equal(parsed.prevFrom.getTime(), parsed.from.getTime() - DAY_MS);
  });
});

describe('Cashier menu-item aggregation', () => {
  const menuItems = buildCashierMenuItemPerformance([
    {
      orderNumber: 'A1',
      status: 'PAID',
      items: [
        { lineId: 'l1', name: 'Burger', type: ' food ', price: 100, quantity: 2 },
        {
          lineId: 'l2',
          name: 'Soda',
          categoryType: 'DRINK',
          price: 50,
          quantity: 1,
          components: [{ kind: 'PRICED_COMPONENT', lineSum: 0, quantity: 2, unitPrice: 5 }],
        },
        { lineId: 'l3', name: 'Void', type: 'FOOD', price: 999, quantity: 1, cancelled: true },
        { lineId: 'l4', name: 'Free note', type: 'FOOD', price: 0, quantity: 1, components: [{ kind: 'NOTE', note: 'x' }] },
        { lineId: 'l5', name: 'Type conflict', type: '', categoryType: 'DRINK', price: 25, quantity: 1 },
      ],
    },
    { orderNumber: 'A2', status: 'READY', items: [{ lineId: 'l1', name: 'Burger', type: 'FOOD', price: 100, quantity: 1 }] },
    { orderNumber: 'A3', status: 'SERVED', items: [{ lineId: 'l1', name: 'Burger', type: 'FOOD', price: 100, quantity: 1 }] },
    { orderNumber: 'A4', status: 'PENDING', items: [{ lineId: 'l1', name: 'Burger', type: 'FOOD', price: 100, quantity: 5 }] },
    { orderNumber: 'A5', status: 'PAYMENT_PENDING', items: [{ lineId: 'l1', name: 'Burger', type: 'FOOD', price: 100, quantity: 5 }] },
    { orderNumber: 'A6', status: 'CANCELLED', items: [{ lineId: 'l1', name: 'Burger', type: 'FOOD', price: 100, quantity: 5 }] },
    { orderNumber: 'A7', status: 'PAID', items: null },
    { orderNumber: 'A8', status: 'PAID', items: [{ lineId: 'l1', name: 'No type', price: 1, quantity: 1, components: null }] },
  ]);

  const byName = new Map(menuItems.map((item) => [item.name, item]));

  test('counts fulfilled units and canonical paid revenue only', () => {
    assert.equal(byName.get('Burger').units, 4);
    assert.equal(byName.get('Burger').orderCount, 3);
    assert.equal(byName.get('Burger').paidRevenue, 200);
    assert.equal(byName.get('Burger').category, 'FOOD');
  });

  test('uses canonical component fallback, cancellation, and category rules', () => {
    assert.equal(byName.get('Soda').units, 1);
    assert.equal(byName.get('Soda').orderCount, 1);
    assert.equal(byName.get('Soda').paidRevenue, 60);
    assert.equal(byName.get('Soda').category, 'DRINK');
    assert.equal(byName.get('Free note').paidRevenue, 0);
    assert.equal(byName.has('Void'), false);
    assert.equal(byName.has('Type conflict'), false);
    assert.equal(byName.has('No type'), false);
  });

  test('returns only projected menu-item fields', () => {
    for (const item of menuItems) {
      assert.deepEqual(
        Object.keys(item).sort(),
        ['category', 'key', 'name', 'orderCount', 'paidRevenue', 'units']
      );
    }
  });
});

describe('Cashier response projection', () => {
  test('limits the payload to canonical revenue and menu items', () => {
    const response = projectCashierReportResponse({
      range: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' },
      kpis: {
        revenue: 100,
        foodRevenue: 60,
        drinkRevenue: 30,
        unattributedItemRevenue: 10,
        baseRevenue: 90,
        componentRevenue: 10,
      },
    }, []);

    assert.deepEqual(Object.keys(response).sort(), ['menuItems', 'range', 'revenue']);
    assert.deepEqual(Object.keys(response.revenue).sort(), ['drink', 'food', 'total', 'unattributed']);
    assert.deepEqual(response.revenue, { total: 100, food: 60, drink: 30, unattributed: 10 });
    assert.deepEqual(response.menuItems, []);
    assert.equal('kpis' in response, false);
  });
});

describe('Cashier report cache freshness', () => {
  function paidOrder(total, createdAt) {
    return {
      _id: `cache-${total}`,
      orderNumber: `C-${total}`,
      status: 'PAID',
      totalAmount: total,
      createdAt,
      paymentMethod: 'CASH',
      items: [{ name: 'Cached', type: 'FOOD', price: total, quantity: 1 }],
    };
  }

  test('default calls still cache; bypass computes fresh data and refreshes the cache', async () => {
    let orders = [paidOrder(100, new Date('2040-01-01T10:00:00.000Z'))];
    let loads = 0;
    const chain = {
      select() { return chain; },
      sort() { return chain; },
      lean() {
        loads += 1;
        return Promise.resolve(orders);
      },
    };
    const conn = { models: { Order: { find() { return chain; } } } };
    const params = {
      from: new Date('2040-01-01T00:00:00.000Z'),
      to: new Date('2040-01-02T00:00:00.000Z'),
      prevFrom: new Date('2039-12-31T00:00:00.000Z'),
      interval: `cache-test-${Date.now()}-${Math.random()}`,
    };

    const first = await getReport(conn, params);
    assert.equal(first.kpis.revenue, 100);
    assert.equal(loads, 1);

    orders = [paidOrder(200, new Date('2040-01-01T11:00:00.000Z'))];
    const cached = await getReport(conn, params);
    assert.equal(cached.kpis.revenue, 100);
    assert.equal(loads, 1);

    const fresh = await getReport(conn, params, { bypassCache: true });
    assert.equal(fresh.kpis.revenue, 200);
    assert.equal(loads, 2);

    const refreshedCache = await getReport(conn, params);
    assert.equal(refreshedCache.kpis.revenue, 200);
    assert.equal(loads, 2);
  });
});

describe('Cashier report rate limiting', () => {
  const request = (headers) => ({
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  });

  test('blocks requests after the per-key limit and exposes Retry-After seconds', () => {
    const key = `cashier-report-limit-${Date.now()}-${Math.random()}`;
    const req = request({ 'x-forwarded-for': '203.0.113.10' });
    const options = { key, limit: 2, windowMs: 60_000 };

    assert.equal(checkRateLimit(req, options).ok, true);
    assert.equal(checkRateLimit(req, options).ok, true);
    const blocked = checkRateLimit(req, options);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfterMs > 0);
    assert.ok(retryAfterSeconds(blocked.retryAfterMs) >= 1);
  });

  test('prefers the trusted Netlify client-connection header', () => {
    const key = `cashier-report-netlify-${Date.now()}-${Math.random()}`;
    const first = request({
      'x-nf-client-connection-ip': '198.51.100.1',
      'x-forwarded-for': '203.0.113.90',
    });
    const second = request({
      'x-nf-client-connection-ip': '198.51.100.2',
      'x-forwarded-for': '203.0.113.90',
    });
    const options = { key, limit: 1, windowMs: 60_000 };

    assert.equal(checkRateLimit(first, options).ok, true);
    assert.equal(checkRateLimit(second, options).ok, true);
    assert.equal(checkRateLimit(first, options).ok, false);
  });
});

describe('Cashier report wiring', () => {
  const route = source('app/api/cashier/report/route.js');
  const ui = source('app/components/CashierUI.jsx');

  test('limits before auth, keeps CASHIER-only access, and stays off manager analytics', () => {
    const limitIndex = route.indexOf('checkRateLimit(');
    const authIndex = route.indexOf('requireAuth(');
    assert.ok(limitIndex >= 0);
    assert.ok(authIndex > limitIndex);
    assert.ok(route.includes('requireAuth(request, ["CASHIER"])'));
    assert.ok(route.includes('parseCashierReportQuery(searchParams)'));
    assert.ok(route.includes('bypassCache'));
    assert.ok(route.includes('projectCashierReportResponse(report, orders)'));
    assert.equal(route.includes('/api/manager/analytics'), false);
    assert.equal(ui.includes('/api/manager/analytics'), false);
  });

  test('manually refreshes use fresh cache and silent polls remain coalesced', () => {
    assert.ok(ui.includes("if (fresh) qs.set('fresh', '1')"));
    assert.ok(ui.includes('REPORT_REFRESH_DEBOUNCE_MS'));
    assert.ok(ui.includes('reportInFlightRef.current'));
    assert.ok(ui.includes('fetchReport({ silent: true, fresh: false })'));
    assert.ok(ui.includes('fetchReport({ silent: true, fresh: true })'));
    assert.ok(ui.includes('scheduleReportRefresh();'));
    assert.ok(ui.includes('reportReqRef.current'));
  });

  test('keeps the mobile report collapsible and the item rows usable', () => {
    assert.ok(ui.includes('window.matchMedia'));
    assert.ok(ui.includes('aria-expanded={reportExpanded}'));
    assert.ok(ui.includes('aria-controls="cashier-report-body"'));
    assert.ok(ui.includes('sm:grid-cols-[minmax(0,1fr)_3rem_3rem_5.25rem]'));
    assert.ok(ui.includes('col-span-2 flex'));
  });
});
