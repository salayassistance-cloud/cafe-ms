import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, f), 'utf8');

// ---- Mirror of the WaiterUI auto-filter (no backend, no storage) ----
// Fully-cancelled orders are never rendered; no dismissal state exists.
function isOrderFullyCancelled(o) {
  const items = o?.items || [];
  if (items.length === 0) return false;
  return items.every((it) => it?.cancelled || o.status === 'CANCELLED');
}

function visibleActiveOrders(activeOrders) {
  return activeOrders.filter((o) => !isOrderFullyCancelled(o));
}

const full2 = {
  _id: 'order12', status: 'CANCELLED',
  items: [
    { lineId: 'l1', quantity: 1, cancelled: true },
    { lineId: 'l2', quantity: 1, cancelled: true },
  ],
};
const full3 = {
  _id: 'order21', status: 'CANCELLED',
  items: [
    { lineId: 'a', quantity: 1, cancelled: true },
    { lineId: 'b', quantity: 1, cancelled: true },
    { lineId: 'c', quantity: 1, cancelled: true },
  ],
};
const single = {
  _id: 'order22', status: 'CANCELLED',
  items: [{ lineId: 'only', quantity: 1, cancelled: true }],
};
const partial = {
  _id: 'order23', status: 'PREPARING',
  items: [
    { lineId: 'p1', quantity: 1, cancelled: true },
    { lineId: 'p2', quantity: 1, cancelled: false },
  ],
};
const mixedPartial = {
  _id: 'order25', status: 'PREPARING',
  items: [
    { lineId: 'f1', type: 'FOOD', quantity: 1, cancelled: true },
    { lineId: 'd1', type: 'DRINK', quantity: 1, cancelled: false },
  ],
};
const mixedFull = {
  _id: 'order26', status: 'CANCELLED',
  items: [
    { lineId: 'f1', type: 'FOOD', quantity: 1, cancelled: true },
    { lineId: 'd1', type: 'DRINK', quantity: 1, cancelled: true },
  ],
};
const activeOrder = {
  _id: 'order24', status: 'PREPARING',
  items: [
    { lineId: 'x1', quantity: 1, cancelled: false },
    { lineId: 'x2', quantity: 1, cancelled: false },
  ],
};

describe('WAITER-CANCELLED-ORDER-CARD - fully cancelled orders never shown', () => {
  test('1. fully cancelled 2-item order is hidden', () => {
    assert.ok(isOrderFullyCancelled(full2));
    assert.deepEqual(visibleActiveOrders([full2]), []);
  });

  test('2. fully cancelled 3-item order is hidden', () => {
    assert.deepEqual(visibleActiveOrders([full3]), []);
  });

  test('3. single-item cancelled order is hidden', () => {
    assert.deepEqual(visibleActiveOrders([single]), []);
  });

  test('4. partially cancelled order stays visible', () => {
    assert.equal(isOrderFullyCancelled(partial), false);
    assert.deepEqual(visibleActiveOrders([partial]), [partial]);
    assert.ok(partial.items.some((it) => !it.cancelled), 'active line preserved');
  });

  test('5. mixed food/drink partially cancelled stays visible', () => {
    assert.equal(isOrderFullyCancelled(mixedPartial), false);
    assert.deepEqual(visibleActiveOrders([mixedPartial]), [mixedPartial]);
  });

  test('6. mixed food/drink fully cancelled is hidden', () => {
    assert.ok(isOrderFullyCancelled(mixedFull));
    assert.deepEqual(visibleActiveOrders([mixedFull]), []);
  });

  test('7. no Remove action exists for cancelled orders (source)', () => {
    const s = src('app/components/WaiterUI.js');
    assert.ok(!s.includes('dismissCancelledOrder'), 'no order-level Remove handler');
    assert.ok(!s.includes('dismissCancelledLine('), 'no line-level Remove handler');
    assert.ok(!s.includes('dismissedOrderKeyFor'), 'no order-level dismissal marker');
  });

  test('8. no dismissal persistence exists for removal (source)', () => {
    const s = src('app/components/WaiterUI.js');
    assert.ok(!s.includes('persistDismissalKey'), 'no dismissal writer');
    assert.ok(!s.includes('bono_waiter_cancelled_dismissed'), 'no dismissal storage key');
    assert.ok(!s.includes('isOrderMarker'), 'no marker reader');
  });

  test('9. refresh/reprocessing keeps fully cancelled hidden (no state needed)', () => {
    for (const again of [full2, full3, single, mixedFull].map((o) => JSON.parse(JSON.stringify(o)))) {
      assert.deepEqual(visibleActiveOrders([again]), []);
    }
    // Mixed list: only non-fully-cancelled survive every reprocessing.
    const mixed = [full2, partial, mixedPartial, mixedFull, activeOrder, single];
    assert.deepEqual(
      visibleActiveOrders(mixed).map((o) => o._id),
      ['order23', 'order25', 'order24']
    );
  });

  test('10. polling keeps fully cancelled hidden', () => {
    const pollAgain = JSON.parse(JSON.stringify(full2));
    assert.deepEqual(visibleActiveOrders([pollAgain]), []);
  });

  test('11. SSE update keeps fully cancelled hidden', () => {
    const viaEvent = JSON.parse(JSON.stringify(full3));
    assert.deepEqual(visibleActiveOrders([viaEvent]), []);
  });

  test('12. active order behavior unchanged', () => {
    assert.equal(isOrderFullyCancelled(activeOrder), false);
    assert.deepEqual(visibleActiveOrders([activeOrder]), [activeOrder]);
  });

  test('13. waiter ownership filtering untouched (source)', () => {
    const s = src('app/components/WaiterUI.js');
    assert.ok(s.includes('visibleActiveOrders'), 'render still uses the filtered list');
    assert.ok(s.includes('isOrderFullyCancelled'), 'single fully-cancelled predicate');
  });

  test('14. filtering performs zero network/API calls (source)', () => {
    const s = src('app/components/WaiterUI.js');
    const start = s.indexOf('const visibleActiveOrders');
    const end = s.indexOf('})();', start);
    const fn = s.slice(start, end);
    assert.ok(!fn.includes('fetch') && !fn.includes('safeFetchJson'), 'pure client-side filter');
  });
});
