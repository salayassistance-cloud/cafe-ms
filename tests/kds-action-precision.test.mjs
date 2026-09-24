import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  stationForView,
  stationStatusOf,
  stationActionOf,
  applyStationUpdate,
  hasActiveStationLines,
} from '../lib/stationStatus.js';

// Mirrors KitchenDisplay pending + merge logic (DB-free, no JSX import).
// Pending identity: String(orderId) -> { station, action, targetStatus }.
// One action = one in-flight request for that exact order+station.
function makePendingStore() {
  const map = new Map();
  return {
    tryStart(orderId, station, action, targetStatus) {
      const pid = String(orderId);
      if (map.has(pid)) return false;
      map.set(pid, { station, action, targetStatus });
      return true;
    },
    finish(orderId) {
      map.delete(String(orderId));
    },
    has(orderId) {
      return map.has(String(orderId));
    },
    get(orderId) {
      return map.get(String(orderId));
    },
    size() {
      return map.size;
    },
  };
}

function pendingLabelFor(info) {
  if (!info) return null;
  if (info.action === 'START_PREP') return 'Starting…';
  if (info.action === 'MARK_READY') return 'Marking Ready…';
  return 'Saving…';
}

// Mirrors fetchOrders per-order reconciliation: only in-flight orders keep
// their optimistic station field; all others take canonical server truth.
function mergePreservingInFlight(prev, incoming, pendingStore) {
  const prevById = new Map(prev.map((o) => [String(o._id), o]));
  return incoming.map((inc) => {
    const pid = String(inc._id);
    const prevOrder = prevById.get(pid);
    if (!prevOrder) return inc;
    const pending = pendingStore.get(pid);
    if (!pending) return inc;
    const field = pending.station === 'BARISTA' ? 'baristaStatus' : pending.station === 'KITCHEN' ? 'kitchenStatus' : null;
    if (field && prevOrder[field] !== undefined && inc[field] !== prevOrder[field]) {
      return { ...inc, [field]: prevOrder[field] };
    }
    return inc;
  });
}

const foodOnly = () => ({
  _id: 'food-1',
  status: 'PENDING',
  kitchenStatus: 'PENDING',
  baristaStatus: null,
  items: [{ lineId: 'f1', type: 'FOOD', cancelled: false }],
});

const drinkOnly = () => ({
  _id: 'drink-1',
  status: 'PENDING',
  kitchenStatus: null,
  baristaStatus: 'PENDING',
  items: [{ lineId: 'd1', type: 'DRINK', cancelled: false }],
});

const mixed = () => ({
  _id: 'mix-10',
  status: 'PENDING',
  kitchenStatus: 'PENDING',
  baristaStatus: 'PENDING',
  items: [
    { lineId: 'm-f1', type: 'FOOD', cancelled: false },
    { lineId: 'm-d1', type: 'DRINK', cancelled: false },
  ],
});

describe('KDS-ACTION-PRECISION - station isolation + in-flight determinism', () => {
  test('1. Kitchen Start Prep does not modify Barista state', () => {
    const o = mixed();
    const next = applyStationUpdate(o, 'KITCHEN', 'PREPARING');
    assert.equal(next.kitchenStatus, 'PREPARING');
    assert.equal(next.baristaStatus, 'PENDING');
    assert.equal(next.status, 'PENDING');
  });

  test('2. Barista Start Prep does not modify Kitchen state', () => {
    const o = mixed();
    const next = applyStationUpdate(o, 'BARISTA', 'PREPARING');
    assert.equal(next.baristaStatus, 'PREPARING');
    assert.equal(next.kitchenStatus, 'PENDING');
  });

  test('3. Kitchen Mark Ready does not modify Barista state', () => {
    const o = { ...mixed(), kitchenStatus: 'PREPARING', baristaStatus: 'PREPARING' };
    const next = applyStationUpdate(o, 'KITCHEN', 'READY');
    assert.equal(next.kitchenStatus, 'READY');
    assert.equal(next.baristaStatus, 'PREPARING');
  });

  test('4. Barista Mark Ready does not modify Kitchen state', () => {
    const o = { ...mixed(), kitchenStatus: 'PREPARING', baristaStatus: 'PREPARING' };
    const next = applyStationUpdate(o, 'BARISTA', 'READY');
    assert.equal(next.baristaStatus, 'READY');
    assert.equal(next.kitchenStatus, 'PREPARING');
  });

  test('5. Mixed order progresses independently per station', () => {
    let o = mixed();
    assert.equal(stationActionOf(o, 'KITCHEN'), 'START_PREP');
    assert.equal(stationActionOf(o, 'BARISTA'), 'START_PREP');
    o = applyStationUpdate(o, 'KITCHEN', 'PREPARING');
    assert.equal(stationActionOf(o, 'KITCHEN'), 'MARK_READY');
    assert.equal(stationActionOf(o, 'BARISTA'), 'START_PREP');
    o = applyStationUpdate(o, 'KITCHEN', 'READY');
    assert.equal(stationActionOf(o, 'KITCHEN'), null);
    assert.equal(stationActionOf(o, 'BARISTA'), 'START_PREP');
    o = applyStationUpdate(o, 'BARISTA', 'PREPARING');
    assert.equal(stationActionOf(o, 'BARISTA'), 'MARK_READY');
    o = applyStationUpdate(o, 'BARISTA', 'READY');
    assert.equal(stationActionOf(o, 'BARISTA'), null);
    assert.equal(stationActionOf(o, 'KITCHEN'), null);
  });

  test('6. FOOD-only order never exposes Barista action', () => {
    const o = foodOnly();
    assert.equal(stationActionOf(o, 'KITCHEN'), 'START_PREP');
    assert.equal(stationActionOf(o, 'BARISTA'), null);
    assert.equal(hasActiveStationLines(o, 'KITCHEN'), true);
    assert.equal(hasActiveStationLines(o, 'BARISTA'), false);
  });

  test('7. DRINK-only order never exposes Kitchen action', () => {
    const o = drinkOnly();
    assert.equal(stationActionOf(o, 'BARISTA'), 'START_PREP');
    assert.equal(stationActionOf(o, 'KITCHEN'), null);
  });

  test('8. In-flight Kitchen action does not block Barista order action', () => {
    const kitchenPending = makePendingStore();
    const baristaPending = makePendingStore();
    assert.equal(kitchenPending.tryStart('mix-10', 'KITCHEN', 'START_PREP', 'PREPARING'), true);
    assert.equal(baristaPending.has('mix-10'), false);
    assert.equal(baristaPending.tryStart('mix-10', 'BARISTA', 'START_PREP', 'PREPARING'), true);
  });

  test('9. In-flight Barista action does not block Kitchen order action', () => {
    const kitchenPending = makePendingStore();
    const baristaPending = makePendingStore();
    assert.equal(baristaPending.tryStart('mix-11', 'BARISTA', 'START_PREP', 'PREPARING'), true);
    assert.equal(kitchenPending.tryStart('mix-11', 'KITCHEN', 'START_PREP', 'PREPARING'), true);
    assert.equal(kitchenPending.tryStart('mix-12', 'KITCHEN', 'START_PREP', 'PREPARING'), true);
  });

  test('10. Duplicate click for same order+station is prevented', () => {
    const p = makePendingStore();
    assert.equal(p.tryStart('order-10', 'KITCHEN', 'START_PREP', 'PREPARING'), true);
    assert.equal(p.tryStart('order-10', 'KITCHEN', 'START_PREP', 'PREPARING'), false);
    assert.equal(p.tryStart('order-10', 'KITCHEN', 'MARK_READY', 'READY'), false);
    p.finish('order-10');
    assert.equal(p.tryStart('order-10', 'KITCHEN', 'MARK_READY', 'READY'), true);
  });

  test('11. Stale poll cannot regress an in-flight station action', () => {
    const p = makePendingStore();
    p.tryStart('mix-10', 'KITCHEN', 'START_PREP', 'PREPARING');
    const optimistic = applyStationUpdate(mixed(), 'KITCHEN', 'PREPARING');
    const staleIncoming = [mixed()];
    const merged = mergePreservingInFlight([optimistic], staleIncoming, p);
    assert.equal(merged[0].kitchenStatus, 'PREPARING');
    assert.equal(merged[0].baristaStatus, 'PENDING');
    // Other orders still take server truth.
    const otherIncoming = [{ ...foodOnly(), _id: 'other', kitchenStatus: 'READY' }];
    const mergedOther = mergePreservingInFlight([foodOnly()], otherIncoming, p);
    assert.equal(mergedOther[0].kitchenStatus, 'READY');
  });

  test('12. Failed action restores actual server state', () => {
    const server = mixed();
    const optimistic = applyStationUpdate(server, 'KITCHEN', 'PREPARING');
    assert.equal(optimistic.kitchenStatus, 'PREPARING');
    const reverted = server;
    assert.equal(reverted.kitchenStatus, 'PENDING');
    assert.equal(stationActionOf(reverted, 'KITCHEN'), 'START_PREP');
  });

  test('13. Successful action shows correct next station action', () => {
    let o = mixed();
    o = applyStationUpdate(o, 'KITCHEN', 'PREPARING');
    assert.equal(stationActionOf(o, 'KITCHEN'), 'MARK_READY');
    assert.equal(pendingLabelFor({ action: 'START_PREP' }), 'Starting…');
    assert.equal(pendingLabelFor({ action: 'MARK_READY' }), 'Marking Ready…');
    o = applyStationUpdate(o, 'KITCHEN', 'READY');
    assert.equal(stationActionOf(o, 'KITCHEN'), null);
    assert.equal(stationStatusOf(o, 'KITCHEN'), 'READY');
  });

  test('14. Overall order.status never drives station action', () => {
    const o = {
      _id: 'x',
      status: 'PREPARING',
      kitchenStatus: 'PENDING',
      baristaStatus: 'PENDING',
      items: [
        { lineId: 'f', type: 'FOOD', cancelled: false },
        { lineId: 'd', type: 'DRINK', cancelled: false },
      ],
    };
    assert.equal(stationActionOf(o, 'KITCHEN'), 'START_PREP');
    assert.equal(stationActionOf(o, 'BARISTA'), 'START_PREP');
    assert.equal(stationForView('FOOD'), 'KITCHEN');
    assert.equal(stationForView('DRINK'), 'BARISTA');
  });
});
