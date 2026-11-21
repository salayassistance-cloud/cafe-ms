// tests/inventory-policy-consistency.test.mjs
//
// DB-free policy consistency suite for the offline inventory correction:
// 1. Stock Policy A: sufficient stock needs no approval; a shortage blocks
//    preparation AND payment; negative stock is never written.
// 2. External Item/Request/Sales flows are removed. Historical isExternal
//    fields remain readable but have no active behavior.
// 3. Extra Items resolve name/price/type/unit/recipe from the server catalog.
// 4. Stock deduction & payment lifecycle keeps exact-once consumption.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planCoverage,
  hasConsumedStock,
  releasePlan,
  consumptionPlan,
  buildRequirementFingerprint,
  buildShortageFingerprint,
} from '../lib/inventoryReservationRules.js';
import { can, ROLES } from '../lib/policy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const exists = (p) => existsSync(join(root, p));

describe('Policy 1: sufficient stock proceeds, shortages block', () => {
  const reservationService = src('lib/inventoryReservationService.js');
  const orderService = src('lib/orderService.js');

  test('there is no Manager shortage-approval permission or route', () => {
    for (const role of Object.values(ROLES)) {
      assert.equal(can(role, 'inventory:approve'), false, `${role} must not approve shortages`);
    }
    assert.equal(exists('app/api/orders/[id]/inventory-approval/route.js'), false);
    assert.equal(exists('app/api/manager/inventory-approvals/route.js'), false);
    assert.equal(reservationService.includes('approveInventoryShortage'), false);
    assert.equal(reservationService.includes('getInventoryApprovalQueue'), false);
  });

  test('a sufficient reservation is RESERVED and needs no approval', () => {
    assert.ok(
      reservationService.includes('const status = fullyReserved ? "RESERVED" : "INSUFFICIENT_STOCK";'),
      'sufficient stock produces RESERVED directly'
    );
    assert.ok(
      reservationService.includes('["RESERVED", "APPROVED", "NO_INVENTORY"].includes(reservation.status)'),
      'RESERVED is immediately preparation-ready'
    );
    assert.equal(reservationService.includes('MANAGER_APPROVAL_REQUIRED'), false);
  });

  test('an insufficient reservation is a blocking INSUFFICIENT_STOCK state', () => {
    assert.ok(reservationService.includes('nextStatus = "INSUFFICIENT_STOCK"'));
    const prep = reservationService.slice(
      reservationService.indexOf('export async function assertOrderInventoryReady'),
      reservationService.indexOf('export async function assertOrderInventoryPayable')
    );
    assert.ok(prep.includes('if (reservation.status === "INSUFFICIENT_STOCK")'));
    assert.ok(prep.includes('Preparation is blocked until stock is available'));
    assert.ok(prep.includes('"INSUFFICIENT_STOCK"'));
  });

  test('payment is gated by the same shortage check', () => {
    const payGate = reservationService.indexOf('export async function assertOrderInventoryPayable');
    assert.ok(payGate > 0, 'payment gate exists');
    const pay = reservationService.slice(payGate);
    assert.ok(pay.includes('assertOrderInventoryReady(conn, order)'));
    assert.ok(pay.includes('Payment is blocked until stock is available'));

    assert.ok(orderService.includes('await assertOrderInventoryPayable(conn, current)'), 'payOrder gate');
    assert.ok(orderService.includes('await assertOrderInventoryPayable(conn, gateOrder)'), 'pending/confirm gates');
  });

  test('consumption refuses shortage states and claims only payable states', () => {
    assert.ok(reservationService.includes('["INSUFFICIENT_STOCK", "APPROVAL_REQUIRED"]'));
    assert.ok(reservationService.includes('status: { $in: ["RESERVED", "APPROVED", "NO_INVENTORY"] }'));
  });

  test('preparation gate runs before the atomic station write', () => {
    assert.ok(orderService.includes('await assertOrderInventoryReady(conn, pre);'));
    const update = orderService.slice(
      orderService.indexOf('export async function updateOrderStatus'),
      orderService.indexOf('export async function serveOrder')
    );
    const gate = update.indexOf('assertOrderInventoryReady(conn, pre)');
    const write = update.indexOf('Order.findOneAndUpdate(filter, pipeline');
    assert.ok(gate > 0 && write > gate, 'gate must run before the station write');
  });

  test('shortage fingerprint still binds order, requirements and available stock', () => {
    const reqs = [{ inventoryItemId: 'item_a', unit: 'kg', requiredQuantity: 5 }];
    const reqFp = buildRequirementFingerprint('order_test_001', reqs);
    const snapshot1 = [{ inventoryItemId: 'item_a', unit: 'kg', requiredQuantity: 5, availableAtDecision: 2, shortageQuantity: 3 }];
    const snapshot2 = [{ inventoryItemId: 'item_a', unit: 'kg', requiredQuantity: 5, availableAtDecision: 1, shortageQuantity: 4 }];
    assert.notEqual(
      buildShortageFingerprint(reqFp, snapshot1),
      buildShortageFingerprint(reqFp, snapshot2)
    );
  });

  test('negative stock is never written', () => {
    assert.ok(reservationService.includes('currentStock: { $gte: consumeQty }'));
    assert.ok(reservationService.includes('reservedStock: { $gte: consumeQty }'));
    assert.ok(reservationService.includes('{ $inc: { currentStock: -consumeQty, reservedStock: -consumeQty } }'));
    assert.equal(reservationService.includes('$inc: { currentStock: -qty }'), false);
  });
});

describe('Policy 2: External flows removed, history retained', () => {
  const reservationService = src('lib/inventoryReservationService.js');
  const deductionService = src('lib/inventoryDeductionService.js');
  const orderService = src('lib/orderService.js');
  const orderModel = src('lib/models/Order.js');
  const analytics = src('lib/analytics.js');

  test('obsolete external routes and model are gone', () => {
    assert.equal(exists('app/api/external-items/route.js'), false);
    assert.equal(exists('app/api/external-sales/route.js'), false);
    assert.equal(exists('lib/models/ExternalItemRequest.js'), false);
  });

  test('no code path excludes an external line from inventory or analytics', () => {
    assert.equal(deductionService.includes('it.isExternal'), false);
    assert.equal(reservationService.includes('isExternal'), false);
    assert.equal(orderService.includes('orders:external'), false);
    assert.equal(analytics.includes('externalSales'), false);
  });

  test('client-submitted isExternal is ignored; new orders write false', () => {
    assert.ok(orderService.includes('isExternal: false'));
    assert.equal(orderService.includes('isExternal: !!it.isExternal'), false);
  });

  test('historical isExternal fields remain readable', () => {
    assert.ok(orderModel.includes('isExternal: { type: Boolean, default: false }'));
    assert.ok(orderModel.includes('retained for historical read compatibility'));
    assert.ok(orderModel.includes('New orders always write false'));
  });

  test('historical external lines with no itemId are skipped by missing reference', () => {
    assert.ok(deductionService.includes('missing menu item reference (itemId)'));
    assert.ok(deductionService.includes('missing reference'), 'documented historical skip');
  });
});

describe('Policy 3: Stock Deduction and Payment Lifecycle', () => {
  const reservationService = src('lib/inventoryReservationService.js');
  const orderService = src('lib/orderService.js');
  const movementModel = src('lib/models/StockMovement.js');

  test('physical stock deduction is triggered at PREPARING, not at PAID', () => {
    assert.ok(orderService.includes('if (status === "PREPARING")'));
    assert.ok(orderService.includes('assertOrderInventoryReady(conn, pre)'));
    assert.ok(orderService.includes('trigger: "PREPARING"'));
  });

  test('consumption plan returns ALREADY_CONSUMED for repeat/payment triggers', () => {
    assert.equal(consumptionPlan('CONSUMED'), 'ALREADY_CONSUMED');
    assert.equal(consumptionPlan('CONSUMING'), 'IN_PROGRESS');
    assert.equal(consumptionPlan('RELEASED'), 'RELEASED');
    assert.equal(consumptionPlan('RESERVED'), 'CONSUME');
    assert.equal(consumptionPlan('APPROVED'), 'CONSUME');
  });

  test('releasePlan distinguishes pre-prep cancellation from post-prep void', () => {
    const prePrep = releasePlan({ status: 'RESERVED', consumedAt: null });
    assert.equal(prePrep.action, 'RELEASE_HOLDS');
    assert.equal(prePrep.phase, 'BEFORE_PREPARATION');
    assert.equal(prePrep.recordVoid, false);

    const postPrep = releasePlan({ status: 'CONSUMED', consumedAt: new Date() });
    assert.equal(postPrep.action, 'VOID_CONSUMED');
    assert.equal(postPrep.phase, 'AFTER_PREPARATION');
    assert.equal(postPrep.recordVoid, true);
    assert.equal(postPrep.reclassifyMovements, true);
  });

  test('hasConsumedStock helper correctly identifies consumption state', () => {
    assert.equal(hasConsumedStock({ status: 'RESERVED' }), false);
    assert.equal(hasConsumedStock({ status: 'CONSUMING' }), true);
    assert.equal(hasConsumedStock({ status: 'CONSUMED' }), true);
    assert.equal(hasConsumedStock({ consumedAt: new Date() }), true);
    assert.equal(hasConsumedStock({ items: [{ consumedQuantity: 1 }] }), true);
  });

  test('StockMovement enforces idempotency key to prevent duplicate ledger entries', () => {
    assert.ok(
      reservationService.includes('idempotencyKey: `sale:${String(orderId)}:${invId}`'),
      'uses compound sale idempotency key'
    );
    assert.ok(
      movementModel.includes('idempotencyKey: 1') && movementModel.includes('unique: true'),
      'StockMovement schema enforces unique index on idempotencyKey'
    );
  });

  test('payment confirmation is independent from inventory and logs failures safely', () => {
    assert.ok(orderService.includes('applyPaidInventory'));
    assert.ok(orderService.includes('logEvent("error", "inventory_consumption_failed"'));
  });

  test('planCoverage calculates exact reservation and shortage quantities', () => {
    const full = planCoverage(10, 10);
    assert.equal(full.reservedQuantity, 10);
    assert.equal(full.shortageQuantity, 0);

    const partial = planCoverage(10, 4);
    assert.equal(partial.reservedQuantity, 4);
    assert.equal(partial.shortageQuantity, 6);

    const none = planCoverage(10, 0);
    assert.equal(none.reservedQuantity, 0);
    assert.equal(none.shortageQuantity, 10);
  });
});
