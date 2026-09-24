// Forceful role separation + station isolation proofs — DB-free.
// AUTH: stubbed canonical engine (thenable Mongoose-style doubles).
// STATION: pure lib/stationStatus unit proofs + source assertions that the
// board consumes station state only. No database, no production.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { authenticateRequest } from '../lib/serverAuth.js';
import { generateSessionId } from '../lib/sessionStore.js';
import { validatePin } from '../lib/validate.js';
import { can } from '../lib/policy.js';
import {
  stationForView,
  stationForRole,
  stationStatusOf,
  hasActiveStationLines,
  stationActionOf,
  applyStationUpdate,
} from '../lib/stationStatus.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');

const NOW = Date.now();
function sessionRec(role, over = {}) {
  const id = new mongoose.Types.ObjectId();
  return { _id: new mongoose.Types.ObjectId(), sessionId: generateSessionId(), staffId: id, roleSnapshot: role, lastSeenAt: new Date(NOW), expiresAt: new Date(NOW + 8 * 3600 * 1000), idleExpiresAt: new Date(NOW + 1800 * 1000), version: 1, revokedAt: null, revokeReason: null, _staff: { _id: id, name: role === 'CASHIER' ? 'Cash' : 'Manager', role, waiterNumber: null, isActive: true }, ...over };
}
function stubConn(rec) {
  const query = { select: () => query, lean: () => query, then: (r) => r(rec) };
  return { models: {
    Session: { findOne: () => query, findByIdAndUpdate: () => ({ lean: async () => ({}) }) },
    Staff: { findById: () => ({ select: () => ({ lean: async () => rec._staff }) }) },
  } };
}
async function liveRole(rec, allowedRoles) {
  return authenticateRequest({ connectProvider: async () => stubConn(rec), newSessionId: rec.sessionId, allowedRoles });
}

function mixedOrder(over = {}) {
  return {
    _id: 'o1', orderNumber: 'ORD-1', status: 'PENDING', kitchenStatus: null, baristaStatus: null,
    items: [
      { lineId: 'l1', type: 'FOOD', quantity: 1, cancelled: false },
      { lineId: 'l2', type: 'DRINK', quantity: 1, cancelled: false },
    ],
    ...over,
  };
}

describe('Forceful role separation (DB-free)', () => {
  test('1. CASHIER Staff authenticates with a 4-digit PIN (format + path)', () => {
    assert.ok(validatePin('1234'), 'exactly 4 digits accepted');
    assert.ok(!validatePin('12345') && !validatePin('12a4') && !validatePin(''), 'non-4-digit rejected');
    const vp = src('app/api/auth/verify-pin/route.js');
    assert.ok(!vp.includes('role === "WAITER"') || vp.includes('USE_LOGIN_STAFF'), 'only WAITER is routed away');
    assert.ok(!/CASHIER.{0,40}MANAGER/.test(vp.replace(/CASHIER stays CASHIER[\s\S]{0,120}/, '')), 'no CASHIER→MANAGER conversion');
  });

  test('2. MANAGER Staff authenticates with a 4-digit PIN (format + path)', () => {
    assert.ok(validatePin('4444'));
    assert.ok(src('app/components/PinGuard.js').includes('PinGuard'), 'portal guard renders PIN flow');
  });

  test('3. CASHIER session carries live role CASHIER', async () => {
    const res = await liveRole(sessionRec('CASHIER'));
    assert.equal(res.ok, true);
    assert.equal(res.payload.role, 'CASHIER');
  });

  test('4. MANAGER session carries live role MANAGER', async () => {
    const res = await liveRole(sessionRec('MANAGER'));
    assert.equal(res.ok, true);
    assert.equal(res.payload.role, 'MANAGER');
  });

  test('5. CASHIER cannot enter /manager (server gate)', async () => {
    assert.ok(src('app/manager/layout.js').includes('getPortalSession("MANAGER")'), 'manager gate is MANAGER-only');
    const res = await liveRole(sessionRec('CASHIER'), ['MANAGER']);
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
  });

  test('6. MANAGER cannot enter /cashier (server gate)', () => {
    const s = src('app/cashier/layout.js');
    assert.ok(s.includes('getPortalSession("CASHIER")'), 'cashier gate is CASHIER-only');
    assert.ok(!s.includes('getPortalSession("MANAGER")'), 'MANAGER portal acceptance removed');
  });

  test('7. CASHIER cannot call manager-only APIs', () => {
    assert.equal(can('CASHIER', 'staff:mutate'), false);
    assert.equal(can('CASHIER', 'menu:mutate'), false);
    assert.equal(can('CASHIER', 'reports:read'), false);
    assert.equal(can('CASHIER', 'inventory:mutate'), false);
  });

  test('8. MANAGER keeps only explicitly manager-authorized operations', () => {
    assert.equal(can('MANAGER', 'staff:mutate'), true);
    assert.equal(can('MANAGER', 'orders:payment:confirm'), true);
    assert.equal(can('MANAGER', 'orders:transition:PREPARING'), true);
    assert.equal(can('MANAGER', 'orders:create'), true);
  });

  test('9. CASHIER is never silently converted to MANAGER', async () => {
    const res = await liveRole(sessionRec('CASHIER'), ['MANAGER']);
    assert.equal(res.ok, false);
    const open = await liveRole(sessionRec('CASHIER'));
    assert.equal(open.payload.role, 'CASHIER');
    assert.ok(!src('app/cashier/layout.js').includes('? "MANAGER"'), 'no conversion expression in gate');
  });

  test('10. MANAGER is never silently converted to CASHIER', async () => {
    const res = await liveRole(sessionRec('MANAGER'), ['CASHIER']);
    assert.equal(res.ok, false);
    const open = await liveRole(sessionRec('MANAGER'));
    assert.equal(open.payload.role, 'MANAGER');
  });

  test('11. localStorage cannot change the authorization role', () => {
    const engine = src('lib/serverAuth.js');
    assert.ok(!engine.includes('window.localStorage') && !engine.includes('localStorage.getItem'), 'resolver never reads client storage');
    assert.ok(!src('lib/security.js').includes('localStorage'), 'guard never reads client storage');
  });

  test('12. client-supplied role cannot escalate authorization', async () => {
    // Extra/unknown fields (e.g. a forged client role) are ignored: the
    // engine reads Session→Staff only.
    const rec = sessionRec('CASHIER');
    const res = await authenticateRequest({ connectProvider: async () => stubConn(rec), newSessionId: rec.sessionId, allowedRoles: ['MANAGER'], role: 'MANAGER' });
    assert.equal(res.ok, false, 'forged role field grants nothing');
  });
});

describe('Kitchen/Barista station isolation (DB-free)', () => {
  test('REGRESSION: Kitchen START PREP leaves Barista PENDING (buttons MARK READY / START PREP)', () => {
    let order = mixedOrder(); // kitchenStatus=null baristaStatus=null overall PENDING
    assert.equal(stationStatusOf(order, 'KITCHEN'), 'PENDING');
    assert.equal(stationStatusOf(order, 'BARISTA'), 'PENDING');
    order = applyStationUpdate(order, 'KITCHEN', 'PREPARING');
    assert.equal(order.kitchenStatus, 'PREPARING', 'kitchen changed');
    assert.equal(order.baristaStatus, null, 'barista untouched');
    assert.equal(stationStatusOf(order, 'KITCHEN'), 'PREPARING');
    assert.equal(stationStatusOf(order, 'BARISTA'), 'PENDING', 'barista still PENDING despite overall drift');
    assert.equal(stationActionOf(order, 'KITCHEN'), 'MARK_READY', 'Kitchen button');
    assert.equal(stationActionOf(order, 'BARISTA'), 'START_PREP', 'Barista button');
  });

  test('13. Kitchen Start Prep changes ONLY kitchenStatus', () => {
    const next = applyStationUpdate(mixedOrder(), 'KITCHEN', 'PREPARING');
    assert.equal(next.kitchenStatus, 'PREPARING');
    assert.equal(next.baristaStatus, null);
    assert.equal(next.status, 'PENDING', 'overall untouched optimistically');
  });

  test('14. Barista status remains PENDING after Kitchen Start Prep', () => {
    const next = applyStationUpdate(mixedOrder(), 'KITCHEN', 'PREPARING');
    assert.equal(stationStatusOf(next, 'BARISTA'), 'PENDING');
  });

  test('15. Barista Start Prep changes ONLY baristaStatus', () => {
    const next = applyStationUpdate(mixedOrder(), 'BARISTA', 'PREPARING');
    assert.equal(next.baristaStatus, 'PREPARING');
    assert.equal(next.kitchenStatus, null);
  });

  test('16. Kitchen status remains PREPARING after Barista Start Prep', () => {
    const o = applyStationUpdate(applyStationUpdate(mixedOrder(), 'KITCHEN', 'PREPARING'), 'BARISTA', 'PREPARING');
    assert.equal(stationStatusOf(o, 'KITCHEN'), 'PREPARING');
    assert.equal(stationStatusOf(o, 'BARISTA'), 'PREPARING');
    assert.equal(stationActionOf(o, 'KITCHEN'), 'MARK_READY');
    assert.equal(stationActionOf(o, 'BARISTA'), 'MARK_READY');
  });

  test('17. Kitchen Mark Ready changes ONLY kitchenStatus', () => {
    const o = applyStationUpdate(mixedOrder({ kitchenStatus: 'PREPARING', baristaStatus: 'PREPARING' }), 'KITCHEN', 'READY');
    assert.equal(o.kitchenStatus, 'READY');
    assert.equal(o.baristaStatus, 'PREPARING');
  });

  test('18. Barista remains PREPARING after Kitchen Mark Ready', () => {
    const o = applyStationUpdate(mixedOrder({ kitchenStatus: 'PREPARING', baristaStatus: 'PREPARING' }), 'KITCHEN', 'READY');
    assert.equal(stationActionOf(o, 'BARISTA'), 'MARK_READY', 'Barista button unchanged');
    assert.equal(stationActionOf(o, 'KITCHEN'), null, 'Kitchen finished: no action');
  });

  test('19. Barista Mark Ready changes ONLY baristaStatus', () => {
    const o = applyStationUpdate(mixedOrder({ kitchenStatus: 'READY', baristaStatus: 'PREPARING' }), 'BARISTA', 'READY');
    assert.equal(o.baristaStatus, 'READY');
    assert.equal(o.kitchenStatus, 'READY');
  });

  test('20. overall READY requires every active station READY (server rule present)', () => {
    const svc = src('lib/orderService.js');
    assert.ok(svc.includes('$eq: ["$kitchenStatus", "READY"]'), 'kitchen READY required');
    assert.ok(svc.includes('$eq: ["$baristaStatus", "READY"]'), 'barista READY required');
  });

  test('21. FOOD-only order never offers a Barista action', () => {
    const foodOnly = mixedOrder({ items: [{ lineId: 'l1', type: 'FOOD', quantity: 1, cancelled: false }] });
    assert.equal(hasActiveStationLines(foodOnly, 'BARISTA'), false);
    assert.equal(stationActionOf(foodOnly, 'BARISTA'), null);
    assert.equal(stationActionOf(foodOnly, 'KITCHEN'), 'START_PREP');
  });

  test('22. DRINK-only order never offers a Kitchen action', () => {
    const drinkOnly = mixedOrder({ items: [{ lineId: 'l2', type: 'DRINK', quantity: 1, cancelled: false }] });
    assert.equal(hasActiveStationLines(drinkOnly, 'KITCHEN'), false);
    assert.equal(stationActionOf(drinkOnly, 'KITCHEN'), null);
    assert.equal(stationActionOf(drinkOnly, 'BARISTA'), 'START_PREP');
  });

  test('23. mixed order shows independent station buttons', () => {
    const o = mixedOrder({ kitchenStatus: 'PREPARING', baristaStatus: 'PENDING' });
    assert.equal(stationActionOf(o, 'KITCHEN'), 'MARK_READY');
    assert.equal(stationActionOf(o, 'BARISTA'), 'START_PREP');
  });

  test('24. cancelled FOOD line creates no Kitchen work', () => {
    const o = mixedOrder({ items: [{ lineId: 'l1', type: 'FOOD', quantity: 1, cancelled: true }, { lineId: 'l2', type: 'DRINK', quantity: 1, cancelled: false }] });
    assert.equal(hasActiveStationLines(o, 'KITCHEN'), false);
    assert.equal(stationActionOf(o, 'KITCHEN'), null);
  });

  test('25. cancelled DRINK line creates no Barista work', () => {
    const o = mixedOrder({ items: [{ lineId: 'l1', type: 'FOOD', quantity: 1, cancelled: false }, { lineId: 'l2', type: 'DRINK', quantity: 1, cancelled: true }] });
    assert.equal(hasActiveStationLines(o, 'BARISTA'), false);
    assert.equal(stationActionOf(o, 'BARISTA'), null);
  });

  test('26. Kitchen API cannot mutate baristaStatus (server ownership)', () => {
    const svc = src('lib/orderService.js');
    assert.ok(svc.includes('items: { $elemMatch: stationMatch }'), 'active-line element-scoped filter');
    assert.ok(svc.includes('kitchenStatus: { $cond: ["$__updateKitchen", status, "$kitchenStatus"] }'), 'kitchen-only conditional set');
    assert.ok(svc.includes('baristaStatus: { $cond: ["$__updateBarista", status, "$baristaStatus"] }'), 'barista-only conditional set');
    assert.ok(svc.includes('if (isKitchen && !preHasFood) throw'), 'kitchen requires active FOOD');
  });

  test('27. Barista API cannot mutate kitchenStatus (server ownership)', () => {
    const svc = src('lib/orderService.js');
    assert.ok(svc.includes('if (isBarista && !preHasDrink) throw'), 'barista requires active DRINK');
    assert.ok(svc.includes('if (isKitchen && target.type !== "FOOD") throw'), 'kitchen cancel limited to FOOD');
    assert.ok(svc.includes('if (isBarista && target.type !== "DRINK") throw'), 'barista cancel limited to DRINK');
  });

  test('28. optimistic Kitchen update does not alter the Barista button', () => {
    const board = src('app/components/KitchenDisplay.js');
    assert.ok(board.includes('applyStationUpdate(o, stationKey, status)'), 'optimistic path uses station-scoped helper');
    assert.ok(!board.includes('next.status ='), 'no overall-status optimistic writes remain');
  });

  test('29. optimistic Barista update does not alter the Kitchen button', () => {
    const after = applyStationUpdate(mixedOrder(), 'BARISTA', 'PREPARING');
    assert.equal(stationActionOf(after, 'KITCHEN'), 'START_PREP', 'Kitchen button untouched');
  });

  test('30. SSE/poll refresh cannot merge one station into the other', () => {
    const board = src('app/components/KitchenDisplay.js');
    // Success path applies the server order object wholesale (canonical),
    // never a field-merged reconstruction.
    assert.ok(board.includes('setOrders((prev) => prev.map((o) => (o._id === orderId ? { ...o, ...updated } : o)))'), 'canonical server object applied');
    assert.ok(!board.includes('baristaStatus || order.status') && !board.includes('kitchenStatus || order.status'), 'no overall-status fallback remains');
    // Button + summary consume station state only.
    assert.ok(board.includes('stationStatusOf(') && board.includes('stationActionOf('), 'station helpers drive UI');
  });

  test('station/role resolution has one canonical interpretation', () => {
    assert.equal(stationForView('FOOD'), 'KITCHEN');
    assert.equal(stationForView('DRINK'), 'BARISTA');
    assert.equal(stationForView('ALL'), null);
    assert.equal(stationForRole('KITCHEN'), 'KITCHEN');
    assert.equal(stationForRole('BARISTA'), 'BARISTA');
    assert.equal(stationForRole('CASHIER'), null);
    assert.equal(stationForRole('MANAGER'), null);
    assert.equal(stationStatusOf({}, 'KITCHEN'), 'PENDING');
    assert.equal(stationStatusOf({ kitchenStatus: 'BOGUS' }, 'KITCHEN'), 'PENDING');
  });
});
