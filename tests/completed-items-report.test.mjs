import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCompletedItemsDetail, COMPLETED_ITEMS_DETAIL_LIMIT } from '../lib/completedItemsReport.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (file) => readFileSync(join(root, file), 'utf8');

describe('Completed items report detail - DB-free', () => {
  test('projects fulfilled, non-cancelled menu lines with stored prices and extras', () => {
    const { rows } = buildCompletedItemsDetail([{
      _id: 'order-1', orderNumber: 'ORD-1', tableNumber: 7, waiterName: 'Abel', paymentMethod: 'CASH', status: 'PAID',
      paidAt: '2026-10-20T09:00:00.000Z',
      items: [{
        lineId: 'line-1', name: { en: 'Pasta', am: 'ፓስታ' }, type: 'FOOD', quantity: 2, price: 120,
        components: [
          { componentId: 'extra-1', kind: 'PRICED_COMPONENT', name: 'Cheese', quantity: 2, unitPrice: 15, lineSum: 30 },
          { componentId: 'note-1', kind: 'NOTE', note: 'No salt' },
        ],
      }],
    }]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].rowKey, 'order-1:line-1');
    assert.equal(rows[0].name, 'Pasta');
    assert.equal(rows[0].quantity, 2);
    assert.equal(rows[0].unitPrice, 120);
    assert.equal(rows[0].waiterName, 'Abel');
    assert.equal(rows[0].paymentMethod, 'CASH');
    assert.equal(rows[0].itemSubtotal, 240, 'base subtotal is price × quantity only');
    assert.equal(rows[0].components[0].lineSum, 30, 'stored extra price is preserved');
    assert.equal(rows[0].components[1].note, 'No salt');
    assert.equal(rows[0].eventKind, 'PAID_AT');
    assert.equal(rows[0].eventAt, '2026-10-20T09:00:00.000Z');
  });

  test('excludes cancelled and non-fulfilled lines, while retaining READY/SERVED as fulfillment facts', () => {
    const { rows } = buildCompletedItemsDetail([
      { _id: 'pending', status: 'PENDING', items: [{ name: 'Pending', quantity: 1, price: 10 }] },
      { _id: 'ready', status: 'READY', readyAt: '2026-10-20T08:00:00.000Z', items: [{ name: 'Ready', quantity: 1, price: 10 }, { name: 'Void', cancelled: true, quantity: 1, price: 10 }] },
      { _id: 'served', status: 'SERVED', servedAt: '2026-10-20T08:30:00.000Z', items: [{ name: 'Served', quantity: 1, price: 10 }] },
    ]);

    assert.deepEqual(rows.map((row) => row.name), ['Ready', 'Served']);
    assert.equal(rows[0].eventKind, 'READY_AT');
    assert.equal(rows[1].eventKind, 'SERVED_AT');
  });

  test('handles legacy missing identifiers and dates safely without fabricating either', () => {
    const { rows } = buildCompletedItemsDetail([{
      _id: 'legacy-order', status: 'PAID', items: [{ name: 'Legacy', quantity: 1, price: 50 }],
    }]);
    assert.equal(rows[0].lineId, null);
    assert.equal(rows[0].rowKey, 'legacy-order:0');
    assert.equal(rows[0].eventAt, null);
    assert.equal(rows[0].eventKind, null);
    assert.equal(rows[0].waiterName, null);
    assert.equal(rows[0].paymentMethod, null);
  });

  test('uses the canonical component fallback only when a legacy stored lineSum is absent', () => {
    const { rows } = buildCompletedItemsDetail([{
      _id: 'order-2', status: 'PAID', paidAt: '2026-10-20T09:00:00.000Z',
      items: [{ name: 'Coffee', quantity: 1, price: 40, components: [{ kind: 'PRICED_COMPONENT', name: 'Milk', quantity: 2, unitPrice: 5 }] }],
    }]);
    assert.equal(rows[0].components[0].lineSum, 10);
    assert.equal(rows[0].itemSubtotal, 40, 'extra remains separate and is not added to base subtotal');
  });

  test('bounds the response by item lines', () => {
    const items = Array.from({ length: COMPLETED_ITEMS_DETAIL_LIMIT + 1 }, (_, index) => ({ name: `Item ${index}`, quantity: 1, price: 1 }));
    const { rows, truncated } = buildCompletedItemsDetail([{ _id: 'large', status: 'READY', items }]);
    assert.equal(rows.length, COMPLETED_ITEMS_DETAIL_LIMIT);
    assert.equal(truncated, true);
  });

  test('analytics keeps its canonical authorization and Addis half-open range resolver', () => {
    const route = source('app/api/manager/analytics/route.js');
    assert.ok(route.includes('requireAuth(request, ["MANAGER"])'));
    assert.ok(route.includes('resolveReportRange(searchParams)'));
    assert.ok(route.includes('createdAt: { $gte: from, $lt: to }'));
    assert.ok(route.includes('.limit(COMPLETED_ITEMS_DETAIL_ORDER_LIMIT + 1)'));
    assert.ok(route.includes('getReport(conn, { from, to, prevFrom, interval })'));
  });
});
