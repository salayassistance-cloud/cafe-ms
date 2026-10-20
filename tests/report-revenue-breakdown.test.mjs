import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRevenueBreakdowns } from '../lib/reportRevenueBreakdown.js';
import { buildReport } from '../lib/analytics.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (file) => readFileSync(join(root, file), 'utf8');

function paidOrder(id, createdAt, paymentMethod, totalAmount, items, extra = {}) {
  return {
    _id: id,
    status: 'PAID',
    createdAt: new Date(createdAt),
    paymentMethod,
    totalAmount,
    items,
    ...extra,
  };
}

function itemAmount(item) {
  const base = (Number(item?.price) || 0) * (Number(item?.quantity) || 0);
  const components = Array.isArray(item?.components) ? item.components : [];
  const componentSum = components
    .filter((component) => component.kind === 'PRICED_COMPONENT')
    .reduce((sum, component) => (
      sum + (Number(component.lineSum) || Number(component.quantity) * Number(component.unitPrice) || 0)
    ), 0);
  return base + componentSum;
}

function breakdown(orders, effectiveOrderAmount = (order) => Number(order.totalAmount) || 0) {
  return buildRevenueBreakdowns(orders, {
    effectiveOrderAmount,
    activeItemAmount: itemAmount,
  });
}

describe('Manager report revenue breakdown - DB-free', () => {
  test('food and drink revenue stay separate, include priced components once, and reconcile with paid revenue', () => {
    const from = new Date('2026-10-01T00:00:00.000Z');
    const to = new Date('2026-10-03T00:00:00.000Z');
    const orders = [
      paidOrder('cash-food-drink', '2026-10-01T09:00:00.000Z', 'CASH', 270, [
        {
          type: 'FOOD',
          price: 100,
          quantity: 2,
          components: [{ kind: 'PRICED_COMPONENT', lineSum: 20 }],
        },
        { type: 'DRINK', price: 50, quantity: 1 },
      ]),
      paidOrder('cbe-food', '2026-10-01T10:00:00.000Z', 'TRANSFER', 300, [
        { type: 'FOOD', price: 300, quantity: 1 },
      ], { paymentAccountSnapshot: { bankName: 'CBE' } }),
      paidOrder('awash-drink', '2026-10-02T10:00:00.000Z', 'TRANSFER', 120, [
        { type: 'DRINK', price: 40, quantity: 3 },
      ], { paymentAccountSnapshot: { bankName: 'Awash' } }),
      paidOrder('legacy-transfer', '2026-10-02T11:00:00.000Z', 'TELEBIRR', 100, [
        { type: 'FOOD', price: 80, quantity: 1 },
        { type: 'DRINK', price: 20, quantity: 1 },
      ]),
      paidOrder('missing-method', '2026-10-02T12:00:00.000Z', 'NONE', 10, [
        { type: 'FOOD', price: 10, quantity: 1 },
      ]),
      paidOrder('other-item-type', '2026-10-02T13:00:00.000Z', 'CASH', 30, [
        { type: 'OTHER', price: 30, quantity: 1 },
      ]),
      paidOrder('cancelled-line', '2026-10-02T14:00:00.000Z', 'CASH', 200, [
        { type: 'FOOD', price: 100, quantity: 1, cancelled: true },
        { type: 'DRINK', price: 100, quantity: 1 },
      ]),
      {
        _id: 'ready-order',
        status: 'READY',
        createdAt: new Date('2026-10-02T15:00:00.000Z'),
        paymentMethod: 'CASH',
        totalAmount: 999,
        items: [{ type: 'FOOD', price: 999, quantity: 1 }],
      },
      paidOrder('previous-window', '2026-09-30T09:00:00.000Z', 'CASH', 500, [
        { type: 'FOOD', price: 500, quantity: 1 },
      ]),
    ];

    const report = buildReport(orders, from, to, 'daily');
    assert.equal(report.kpis.revenue, 930);
    assert.equal(report.kpis.foodRevenue, 610);
    assert.equal(report.kpis.drinkRevenue, 290);
    assert.equal(report.kpis.unattributedItemRevenue, 30);
    assert.equal(
      report.kpis.foodRevenue + report.kpis.drinkRevenue + report.kpis.unattributedItemRevenue,
      report.kpis.revenue,
      'food + drink + unattributed reconciles to the canonical paid total'
    );

    const byKey = new Map(report.paymentBreakdown.map((entry) => [entry.key, entry]));
    assert.equal(byKey.get('CASH').amount, 400);
    assert.equal(byKey.get('TRANSFER:CBE').amount, 300);
    assert.equal(byKey.get('TRANSFER:AWASH').amount, 120);
    assert.equal(byKey.get('TRANSFER:UNSPECIFIED').amount, 100);
    assert.equal(byKey.get('UNKNOWN').amount, 10);
    assert.equal(
      report.paymentBreakdown.reduce((sum, entry) => sum + entry.amount, 0),
      report.kpis.revenue,
      'payment methods sum to the same paid total'
    );
  });

  test('legacy categoryType is honored; missing or invalid types are never guessed', () => {
    const result = breakdown([
      paidOrder('legacy-type', '2026-10-01T09:00:00.000Z', 'CASH', 100, [
        { type: 'FOOD', price: 10, quantity: 1 },
        { categoryType: 'DRINK', price: 20, quantity: 1 },
        { type: 'SIDE', price: 30, quantity: 1 },
        { price: 40, quantity: 1 },
      ]),
    ]);

    assert.equal(result.foodRevenue, 10);
    assert.equal(result.drinkRevenue, 20);
    assert.equal(result.unattributedRevenue, 70);
  });

  test('cash, CBE/Transfer, other banks, generic transfer, and unknown stay distinct', () => {
    const result = breakdown([
      paidOrder('cash', '2026-10-01T09:00:00.000Z', 'CASH', 100, []),
      paidOrder('cbe', '2026-10-01T09:01:00.000Z', 'TRANSFER', 200, [], { paymentAccountSnapshot: { bankName: 'CBE' } }),
      paidOrder('awash', '2026-10-01T09:02:00.000Z', 'TRANSFER', 300, [], { paymentAccountSnapshot: { bankName: 'Awash' } }),
      paidOrder('dashen-legacy', '2026-10-01T09:03:00.000Z', 'TELEBIRR', 400, [], { paymentAccountSnapshot: { bankName: 'Dashen' } }),
      paidOrder('transfer-no-bank', '2026-10-01T09:04:00.000Z', 'TRANSFER', 500, []),
      paidOrder('none', '2026-10-01T09:05:00.000Z', 'NONE', 600, []),
      paidOrder('missing', '2026-10-01T09:06:00.000Z', undefined, 700, []),
      paidOrder('invalid', '2026-10-01T09:07:00.000Z', 'CARD', 800, []),
    ]);

    const byKey = new Map(result.paymentBreakdown.map((entry) => [entry.key, entry]));
    assert.equal(byKey.get('CASH').amount, 100);
    assert.equal(byKey.get('TRANSFER:CBE').amount, 200);
    assert.equal(byKey.get('TRANSFER:AWASH').amount, 300);
    assert.equal(byKey.get('TRANSFER:DASHEN').amount, 400);
    assert.equal(byKey.get('TRANSFER:UNSPECIFIED').bankName, null);
    assert.equal(byKey.get('TRANSFER:UNSPECIFIED').amount, 500);
    assert.equal(byKey.get('UNKNOWN').amount, 2100);
    assert.equal(byKey.get('UNKNOWN').count, 3);
    assert.ok(!byKey.has('NONE'), 'NONE is not used as a revenue bucket');
  });

  test('duplicate order documents cannot double-count a paid amount or its items', () => {
    const order = paidOrder('duplicate-id', '2026-10-01T09:00:00.000Z', 'CASH', 100, [
      { type: 'FOOD', price: 100, quantity: 1 },
    ]);

    const result = breakdown([order, { ...order }]);
    assert.equal(result.foodRevenue, 100);
    assert.equal(result.paymentBreakdown.find((entry) => entry.key === 'CASH').amount, 100);
    assert.equal(result.paymentBreakdown.find((entry) => entry.key === 'CASH').count, 1);
  });

  test('report date filtering excludes previous-window and non-paid orders from current revenue', () => {
    const from = new Date('2026-10-02T00:00:00.000Z');
    const to = new Date('2026-10-03T00:00:00.000Z');
    const report = buildReport([
      paidOrder('at-from', '2026-10-02T00:00:00.000Z', 'CASH', 100, [
        { type: 'FOOD', price: 100, quantity: 1 },
      ]),
      paidOrder('before-from', '2026-10-01T23:59:59.999Z', 'CASH', 200, [
        { type: 'FOOD', price: 200, quantity: 1 },
      ]),
      {
        _id: 'pending',
        status: 'PAYMENT_PENDING',
        createdAt: new Date('2026-10-02T10:00:00.000Z'),
        paymentMethod: 'CASH',
        totalAmount: 300,
        items: [{ type: 'FOOD', price: 300, quantity: 1 }],
      },
    ], from, to, 'daily');

    assert.equal(report.kpis.revenue, 100);
    assert.equal(report.kpis.foodRevenue, 100);
    assert.equal(report.paymentBreakdown.length, 1);
    assert.equal(report.paymentBreakdown[0].amount, 100);
  });

  test('analytics keeps canonical paid-revenue helpers and half-open Addis range query', () => {
    const analytics = source('lib/analytics.js');
    assert.ok(analytics.includes('const revenueBreakdowns = buildRevenueBreakdowns(currentOrders'));
    assert.ok(analytics.includes('.filter((o) => o.status === "PAID")'));
    assert.ok(analytics.includes('function effectiveOrderAmount'));
    const service = source('lib/reportService.js');
    assert.ok(service.includes('createdAt: { $gte: prevFrom, $lt: to }'));
    assert.ok(service.includes('resolveReportRange'));
    const route = source('app/api/manager/analytics/route.js');
    assert.ok(route.includes('requireAuth(request, ["MANAGER"])'));
  });
});
