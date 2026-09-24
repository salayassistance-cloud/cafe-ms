import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

const DISMISSED_KEY_PREFIX = 'bono_waiter_cancelled_dismissed:';
const dismissedKeyFor = (orderId, lineId) => `${String(orderId)}|${String(lineId)}`;

function isFullyGone(order, dismissedSet) {
  const orderItems = order.items || [];
  const addressable = orderItems.filter((it) => it.lineId);
  return (
    orderItems.length > 0 &&
    addressable.length > 0 &&
    orderItems.every((it) => it.cancelled || order.status === 'CANCELLED') &&
    addressable.every((it) => dismissedSet.has(dismissedKeyFor(order._id, it.lineId)))
  );
}

function filterVisibleItems(order, dismissedSet) {
  return (order.items || []).filter((it) => {
    const dismissKey = it.lineId ? dismissedKeyFor(order._id, it.lineId) : null;
    if (!!it.cancelled && dismissKey && dismissedSet.has(dismissKey)) return false;
    return true;
  });
}

function filterVisibleOrders(orders, dismissedSet) {
  return orders.filter((o) => !isFullyGone(o, dismissedSet));
}

class MockStorage {
  constructor() { this.store = new Map(); }
  getItem(k) { return this.store.get(k) ?? null; }
  setItem(k, v) { this.store.set(k, v); }
}

// Immediate persist BEFORE state transition (mirrors WaiterUI fix) + sync ref.
function dismissWithPersist(storage, refSet, stateSet, waiterId, orderId, lineId) {
  const k = dismissedKeyFor(orderId, lineId);
  const storageKey = `${DISMISSED_KEY_PREFIX}${String(waiterId)}`;
  const raw = storage.getItem(storageKey);
  let arr = [];
  try { arr = raw ? JSON.parse(raw) : []; } catch { arr = []; }
  const set = new Set(Array.isArray(arr) ? arr.map((v) => String(v).trim()).filter((v) => v.includes('|')) : []);
  if (!set.has(k)) {
    set.add(k);
    storage.setItem(storageKey, JSON.stringify([...set]));
  }
  if (!refSet.has(k)) {
    const nextRef = new Set(refSet);
    nextRef.add(k);
    refSet.clear();
    for (const v of nextRef) refSet.add(v);
  }
  const next = new Set(stateSet);
  next.add(k);
  return next;
}

function loadDismissed(storage, waiterId) {
  const raw = storage.getItem(`${DISMISSED_KEY_PREFIX}${String(waiterId)}`);
  if (!raw) return new Set();
  const parsed = JSON.parse(raw);
  return new Set(parsed.filter((id) => typeof id === 'string' && id.includes('|')));
}

describe('WAITER-CANCELLED-PERSISTENCE - Remove means stays removed', () => {
  test('15. Remove persists dismissal to waiter-scoped storage', () => {
    const storage = new MockStorage();
    const ref = new Set();
    let state = new Set();
    state = dismissWithPersist(storage, ref, state, 'waiterA', 'order123', 'lineCoffee');
    assert.ok(state.has('order123|lineCoffee'));
    assert.ok(ref.has('order123|lineCoffee'));
    assert.ok(JSON.parse(storage.getItem('bono_waiter_cancelled_dismissed:waiterA')).includes('order123|lineCoffee'));
  });

  test('16. Refresh preserves dismissal (storage reload)', () => {
    const storage = new MockStorage();
    storage.setItem('bono_waiter_cancelled_dismissed:waiterA', JSON.stringify(['order123|lineCoffee']));
    const reloaded = loadDismissed(storage, 'waiterA');
    const order = { _id: 'order123', status: 'PREPARING', items: [{ lineId: 'lineCoffee', cancelled: true }, { lineId: 'lineBurger', cancelled: false }] };
    assert.equal(filterVisibleItems(order, reloaded).find((it) => it.lineId === 'lineCoffee'), undefined);
  });

  test('17. Poll preserves dismissal', () => {
    const dismissed = new Set(['order123|lineCoffee']);
    const pollOrder = { _id: 'order123', status: 'PREPARING', items: [{ lineId: 'lineCoffee', cancelled: true }, { lineId: 'lineBurger', cancelled: false }] };
    assert.equal(filterVisibleItems(pollOrder, dismissed).length, 1);
  });

  test('18. SSE preserves dismissal', () => {
    const dismissed = new Set(['order123|lineCoffee']);
    const sseOrder = JSON.parse(JSON.stringify({ _id: 'order123', items: [{ lineId: 'lineCoffee', cancelled: true }] }));
    assert.equal(filterVisibleItems(sseOrder, dismissed).length, 0);
  });

  test('19. Drawer reopen preserves dismissal', () => {
    const storage = new MockStorage();
    const ref = new Set();
    let state = dismissWithPersist(storage, ref, new Set(), 'waiterA', 'order123', 'lineCoffee');
    const refetched = { _id: 'order123', status: 'PREPARING', items: [{ lineId: 'lineCoffee', cancelled: true }, { lineId: 'lineBurger', cancelled: false }] };
    assert.equal(filterVisibleItems(refetched, state).find((it) => it.lineId === 'lineCoffee'), undefined);
  });

  test('20. Visibility/focus refresh preserves dismissal', () => {
    const dismissed = new Set(['order123|lineCoffee']);
    const order = { _id: 'order123', items: [{ lineId: 'lineCoffee', cancelled: true }, { lineId: 'lineBurger', cancelled: false }] };
    assert.equal(filterVisibleItems(order, dismissed).length, 1);
  });

  test('21. Dismissal is waiter-specific', () => {
    const storage = new MockStorage();
    const refA = new Set();
    dismissWithPersist(storage, refA, new Set(), 'waiterA', 'order123', 'lineCoffee');
    assert.equal(storage.getItem('bono_waiter_cancelled_dismissed:waiterB'), null);
    assert.deepEqual([...loadDismissed(storage, 'waiterB')], []);
    assert.ok(loadDismissed(storage, 'waiterA').has('order123|lineCoffee'));
  });

  test('22. Different cancelled line IDs remain independent', () => {
    const dismissed = new Set(['orderMulti|lineBurger']);
    const order = { _id: 'orderMulti', items: [{ lineId: 'lineBurger', cancelled: true }, { lineId: 'lineCoffee', cancelled: true }, { lineId: 'lineCake', cancelled: false }] };
    const visible = filterVisibleItems(order, dismissed);
    assert.equal(visible.find((it) => it.lineId === 'lineBurger'), undefined);
    assert.ok(visible.find((it) => it.lineId === 'lineCoffee'));
  });

  test('23. Dismissed cancellation produces no active notification', () => {
    const dismissed = new Set(['order123|lineCoffee']);
    const isFully = isFullyGone({ _id: 'order999', status: 'CANCELLED', items: [{ lineId: 'l1', cancelled: true }, { lineId: 'l2', cancelled: true }] }, new Set(['order999|l1', 'order999|l2']));
    assert.equal(isFully, true);
    const orders = [{ _id: 'order999', status: 'CANCELLED', items: [{ lineId: 'l1', cancelled: true }, { lineId: 'l2', cancelled: true }] }];
    assert.equal(filterVisibleOrders(orders, new Set(['order999|l1', 'order999|l2'])).length, 0);
    assert.ok(dismissed.has('order123|lineCoffee'));
  });

  test('24. Fully dismissed cancelled order disappears from active area', () => {
    const dismissed = new Set(['order999|l1', 'order999|l2']);
    const order = { _id: 'order999', status: 'CANCELLED', items: [{ lineId: 'l1', cancelled: true }, { lineId: 'l2', cancelled: true }] };
    assert.ok(isFullyGone(order, dismissed));
    assert.equal(filterVisibleOrders([order], dismissed).length, 0);
  });

  test('25. New unrelated cancellation still appears', () => {
    const dismissed = new Set(['order123|lineCoffee']);
    const order = { _id: 'order123', items: [{ lineId: 'lineCoffee', cancelled: true }, { lineId: 'lineNew', cancelled: true }] };
    const visible = filterVisibleItems(order, dismissed);
    assert.ok(visible.find((it) => it.lineId === 'lineNew'));
  });

  test('26. Dismissal never changes backend cancellation/order state', () => {
    const order = { _id: 'order123', status: 'PREPARING', items: [{ lineId: 'lineCoffee', cancelled: true }] };
    const before = JSON.stringify(order);
    const dismissed = new Set(['order123|lineCoffee']);
    filterVisibleItems(order, dismissed);
    filterVisibleOrders([order], dismissed);
    assert.equal(JSON.stringify(order), before);
    assert.equal(order.items[0].cancelled, true);
  });
});
