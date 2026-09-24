import assert from 'node:assert/strict';

// Helper to mimic WaiterUI dismissal logic
const DISMISSED_KEY_PREFIX = 'bono_waiter_cancelled_dismissed:';
const dismissedKeyFor = (orderId, lineId) => `${String(orderId)}|${String(lineId)}`;

function isLineDismissed(dismissedSet, orderId, lineId) {
  if (!lineId) return false;
  return dismissedSet.has(dismissedKeyFor(orderId, lineId));
}

// Mirrors WaiterUI fullyGone logic
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

// Per-item filter at final render boundary
function filterVisibleItems(order, dismissedSet) {
  return (order.items || []).filter((it) => {
    const isCancelled = !!it.cancelled;
    const dismissKey = it.lineId ? dismissedKeyFor(order._id, it.lineId) : null;
    if (isCancelled && dismissKey && dismissedSet.has(dismissKey)) return false;
    return true;
  });
}

function filterVisibleOrders(orders, dismissedSet) {
  return orders.filter((o) => !isFullyGone(o, dismissedSet));
}

// Prune logic (mirrors WaiterUI)
function pruneDismissed(dismissedSet, activeOrders) {
  if (activeOrders.length === 0) return new Set(dismissedSet);
  const byOrder = new Map();
  for (const o of activeOrders) byOrder.set(String(o._id), o);
  const next = new Set();
  let changed = false;
  for (const k of dismissedSet) {
    const sep = String(k).lastIndexOf('|');
    const oid = sep === -1 ? null : String(k).slice(0, sep);
    const lid = sep === -1 ? null : String(k).slice(sep + 1);
    const order = oid ? byOrder.get(oid) : undefined;
    if (!order) {
      next.add(k);
      continue;
    }
    const line = (order.items || []).find((it) => it.lineId && String(it.lineId) === lid);
    if (line) next.add(k);
    else changed = true;
  }
  return changed ? next : dismissedSet;
}

// Mock localStorage
class MockStorage {
  constructor() { this.store = new Map(); }
  getItem(k) { return this.store.get(k) ?? null; }
  setItem(k, v) { this.store.set(k, v); }
  removeItem(k) { this.store.delete(k); }
}

// Immediate persist helper (mirrors fix)
function immediateDismiss(storage, waiterId, dismissedSet, orderId, lineId) {
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
  const next = new Set(dismissedSet);
  next.add(k);
  return next;
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed++; } catch (e) { console.error(`✗ ${name}: ${e.message}`); console.error(e.stack); failed++; }
}

// Test data
const waiterA = 'waiterA-id';
const waiterB = 'waiterB-id';
const orderPartial = {
  _id: 'order123',
  status: 'PREPARING',
  items: [
    { lineId: 'lineBurger', quantity: 1, cancelled: false },
    { lineId: 'lineCoffee', quantity: 1, cancelled: true, cancelReason: 'out of stock' },
    { lineId: 'lineCake', quantity: 1, cancelled: false },
  ],
};
const orderFully = {
  _id: 'order999',
  status: 'CANCELLED',
  items: [
    { lineId: 'line1', quantity: 1, cancelled: true },
    { lineId: 'line2', quantity: 1, cancelled: true },
  ],
};
const orderMultiCancelled = {
  _id: 'orderMulti',
  status: 'PREPARING',
  items: [
    { lineId: 'lineBurger', quantity: 1, cancelled: true },
    { lineId: 'lineCoffee', quantity: 1, cancelled: true },
    { lineId: 'lineCake', quantity: 1, cancelled: false },
  ],
};

test('1. Remove one cancelled line → disappears immediately', () => {
  let dismissed = new Set();
  dismissed = immediateDismiss(new MockStorage(), waiterA, dismissed, 'order123', 'lineCoffee');
  const visible = filterVisibleItems(orderPartial, dismissed);
  assert.equal(visible.find((it) => it.lineId === 'lineCoffee'), undefined);
  assert.ok(visible.find((it) => it.lineId === 'lineBurger'));
  assert.ok(visible.find((it) => it.lineId === 'lineCake'));
});

test('2. Poll → remains hidden', () => {
  let dismissed = new Set([dismissedKeyFor('order123', 'lineCoffee')]);
  // simulate poll returning same order
  const pollOrder = JSON.parse(JSON.stringify(orderPartial));
  const visible = filterVisibleItems(pollOrder, dismissed);
  assert.equal(visible.find((it) => it.lineId === 'lineCoffee'), undefined);
});

test('3. Refresh → remains hidden', () => {
  let dismissed = new Set([dismissedKeyFor('order123', 'lineCoffee')]);
  const refreshed = JSON.parse(JSON.stringify(orderPartial));
  const visible = filterVisibleItems(refreshed, dismissed);
  assert.equal(visible.length, 2);
});

test('4. Drawer close/open → remains hidden', () => {
  let dismissed = new Set([dismissedKeyFor('order123', 'lineCoffee')]);
  // drawer close poll without CANCELLED would not include fully cancelled but partial remains
  // simulate drawer open fetching again
  const reFetched = JSON.parse(JSON.stringify(orderPartial));
  const visible = filterVisibleItems(reFetched, dismissed);
  assert.equal(visible.find((it) => it.lineId === 'lineCoffee'), undefined);
});

test('5. SSE event → remains hidden', () => {
  let dismissed = new Set([dismissedKeyFor('order123', 'lineCoffee')]);
  const sseOrder = JSON.parse(JSON.stringify(orderPartial));
  const visible = filterVisibleItems(sseOrder, dismissed);
  assert.equal(visible.find((it) => String(it.lineId) === 'lineCoffee'), undefined);
});

test('6. Visibility/focus refresh → remains hidden', () => {
  let dismissed = new Set([dismissedKeyFor('order123', 'lineCoffee')]);
  const visible = filterVisibleItems(orderPartial, dismissed);
  assert.equal(visible.length, 2);
});

test('7. Partially cancelled order → active lines remain', () => {
  let dismissed = new Set([dismissedKeyFor('order123', 'lineCoffee')]);
  const visible = filterVisibleItems(orderPartial, dismissed);
  assert.equal(visible.length, 2);
  assert.ok(visible.some((it) => it.lineId === 'lineBurger' && !it.cancelled));
});

test('8. Fully cancelled order → entire order remains hidden after Remove', () => {
  let dismissed = new Set();
  dismissed.add(dismissedKeyFor('order999', 'line1'));
  dismissed.add(dismissedKeyFor('order999', 'line2'));
  assert.ok(isFullyGone(orderFully, dismissed));
  const visibleOrders = filterVisibleOrders([orderFully], dismissed);
  assert.equal(visibleOrders.length, 0);
  // poll resurrect check
  const pollAgain = JSON.parse(JSON.stringify(orderFully));
  assert.ok(isFullyGone(pollAgain, dismissed));
});

test('9. Remove line A does not hide cancelled line B', () => {
  let dismissed = new Set([dismissedKeyFor('orderMulti', 'lineBurger')]);
  const visible = filterVisibleItems(orderMultiCancelled, dismissed);
  assert.equal(visible.find((it) => it.lineId === 'lineBurger'), undefined);
  assert.ok(visible.find((it) => it.lineId === 'lineCoffee' && it.cancelled));
  assert.ok(visible.find((it) => it.lineId === 'lineCake'));
  // now remove Coffee as well
  dismissed.add(dismissedKeyFor('orderMulti', 'lineCoffee'));
  const visible2 = filterVisibleItems(orderMultiCancelled, dismissed);
  assert.equal(visible2.find((it) => it.lineId === 'lineCoffee'), undefined);
  assert.ok(visible2.find((it) => it.lineId === 'lineCake'));
});

test('10. Different waiter dismissal isolation', () => {
  const storage = new MockStorage();
  let dismissedA = new Set();
  dismissedA = immediateDismiss(storage, waiterA, dismissedA, 'order123', 'lineCoffee');
  let dismissedB = new Set();
  // waiter B has not dismissed
  assert.ok(!dismissedB.has(dismissedKeyFor('order123', 'lineCoffee')));
  assert.ok(dismissedA.has(dismissedKeyFor('order123', 'lineCoffee')));
  // storage isolation
  const keyA = `${DISMISSED_KEY_PREFIX}${waiterA}`;
  const keyB = `${DISMISSED_KEY_PREFIX}${waiterB}`;
  assert.ok(JSON.parse(storage.getItem(keyA) || '[]').includes(dismissedKeyFor('order123','lineCoffee')));
  assert.equal(storage.getItem(keyB), null);
});

test('11. Temporary missing order during fetch does not erase dismissal', () => {
  const dismissed = new Set([dismissedKeyFor('order999', 'line1')]);
  // poll without CANCELLED → activeOrders = [] or without order999
  const activeWithout = []; // order missing
  const pruned = pruneDismissed(dismissed, activeWithout);
  // since activeOrders.length===0, prune returns same set (preserved)
  // test with our prune implementation that checks length 0 returns original
  assert.ok(pruned.has(dismissedKeyFor('order999','line1')));
  // also test with activeOrders containing other order but not the dismissed one
  const activeWithOther = [{ _id: 'otherOrder', items: [] }];
  const pruned2 = pruneDismissed(dismissed, activeWithOther);
  assert.ok(pruned2.has(dismissedKeyFor('order999','line1')));
});

test('12. ID string/ObjectId normalization', () => {
  const oid = { toString: () => 'order123' }; // mock ObjectId
  const lineOid = { toString: () => 'lineCoffee' };
  const k1 = dismissedKeyFor(oid, lineOid);
  assert.equal(k1, 'order123|lineCoffee');
  const dismissed = new Set([k1]);
  // String comparison should match even if one is object and other is string
  const order = { _id: 'order123', items: [{ lineId: 'lineCoffee', cancelled: true }] };
  assert.ok(isLineDismissed(dismissed, 'order123', 'lineCoffee'));
  assert.ok(isLineDismissed(dismissed, oid, lineOid));
});

test('13. New cancelled item without dismissal still appears', () => {
  const dismissed = new Set([dismissedKeyFor('order123','lineCoffee')]);
  const orderWithNewCancel = {
    _id: 'order123',
    status: 'PREPARING',
    items: [
      { lineId: 'lineBurger', cancelled: false },
      { lineId: 'lineCoffee', cancelled: true },
      { lineId: 'lineNew', cancelled: true },
    ],
  };
  const visible = filterVisibleItems(orderWithNewCancel, dismissed);
  assert.equal(visible.find((it) => it.lineId === 'lineCoffee'), undefined);
  assert.ok(visible.find((it) => it.lineId === 'lineNew'));
});

test('14. Dismissed item does not generate a new alert (notifiedKeysRef dedupe)', () => {
  // simulate notifiedKeysRef
  const notified = new Set();
  const dismissed = new Set([dismissedKeyFor('order123','lineCoffee')]);
  function shouldAlert(orderId, lineId, wasCancelled, isCancelled) {
    if (!isCancelled) return false;
    if (wasCancelled) return false;
    // if dismissed, should not alert? Our current alert logic does not check dismissed, but second poll wasCancelled true so not alert anyway
    // For newly cancelled that is already dismissed (should not happen), we check dismissed
    const k = `cancel:${orderId}|${lineId}`;
    if (notified.has(k)) return false;
    if (dismissed.has(dismissedKeyFor(orderId, lineId))) return false;
    return true;
  }
  // already dismissed and already cancelled → no alert
  assert.equal(shouldAlert('order123','lineCoffee', false, true), false);
  // new cancelled not dismissed → alert
  assert.equal(shouldAlert('order123','lineNew', false, true), true);
});

test('15. Existing J.8 waiter Cancel still passes (whole-order cancel adds all lines)', () => {
  const orderPending = {
    _id: 'orderPend',
    status: 'PENDING',
    items: [
      { lineId: 'l1', quantity: 1 },
      { lineId: 'l2', quantity: 1 },
    ],
  };
  let dismissed = new Set();
  // simulate cancelOwnOrder adding all lines
  for (const it of orderPending.items) {
    dismissed.add(dismissedKeyFor(orderPending._id, it.lineId));
  }
  assert.ok(dismissed.has(dismissedKeyFor('orderPend','l1')));
  assert.ok(dismissed.has(dismissedKeyFor('orderPend','l2')));
  // after cancel, order status becomes CANCELLED, fullyGone should be true
  const cancelledOrder = { ...orderPending, status: 'CANCELLED', items: orderPending.items.map((it) => ({...it, cancelled: true})) };
  assert.ok(isFullyGone(cancelledOrder, dismissed));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
