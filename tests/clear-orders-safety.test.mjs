// Phase 2.2 — clear-orders destructive-action safety (source-level, DB-free).
//
// The endpoint is not executed. These assertions pin the safety contract:
// preview, explicit confirmation, evidence preservation, in-flight refusal,
// and a counter reset that cannot duplicate order numbers.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const route = () => readFileSync(join(root, 'app/api/manager/settings/clear-orders/route.js'), 'utf8');
const routeCode = () =>
  route()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

describe('Phase 2.2 clear-orders authorization and confirmation', () => {
  test('remains MANAGER-only with own-PIN step-up', () => {
    const s = route();
    assert.ok(s.includes('requireAuth(request, ["MANAGER"])'), 'MANAGER gate');
    assert.ok(s.includes('verifyStaffPinById(conn, auth.payload.staffId, currentManagerPin)'), 'requesting manager own PIN');
    assert.ok(s.includes('auth.payload.staffId'), 'identity from session, not client');
    assert.ok(!s.includes('body.staffId') && !s.includes('body.role'), 'no client identity authority');
  });

  test('requires a literal confirmation token before connecting to the DB', () => {
    const s = route();
    assert.ok(s.includes('const CONFIRMATION_TOKEN = "CLEAR-ORDERS";'));
    assert.ok(s.includes('confirmation !== CONFIRMATION_TOKEN'), 'execution is token-gated');
    assert.ok(s.includes('CLEAR_ORDERS_CONFIRMATION_REQUIRED'), 'stable error code');
    const tokenGate = s.indexOf('confirmation !== CONFIRMATION_TOKEN');
    const connect = s.indexOf('connectToDatabase()');
    assert.ok(tokenGate > 0 && connect > tokenGate, 'token is validated before DB access');
  });

  test('dry-run preview mutates nothing and returns before any delete', () => {
    const s = route();
    assert.ok(s.includes('const dryRun = body?.dryRun === true || body?.preview === true;'));
    const preview = s.indexOf('if (dryRun)');
    const firstDelete = s.indexOf('Order.deleteMany');
    assert.ok(preview > 0 && firstDelete > preview, 'preview branch returns before deletion');
    assert.ok(s.includes('preview: true') && s.includes('mutated: false'), 'explicit non-mutation result');
    assert.ok(s.includes('blockedReasons'), 'preview explains why execution would refuse');
  });

  test('rate limit and payload size guard preserved', () => {
    const s = route();
    assert.ok(s.includes('checkRateLimit(request, { key: "clear_orders"'));
    assert.ok(s.includes('Payload too large'));
  });
});

describe('Phase 2.2 clear-orders evidence protection', () => {
  test('PAID orders block the reset with an auditable error', () => {
    const s = route();
    assert.ok(s.includes('if (paidOrders > 0)'), 'PAID preflight');
    assert.ok(s.includes('CLEAR_ORDERS_PAID_EVIDENCE_PRESENT'), 'stable refusal code');
    assert.ok(s.includes('financial evidence'));
    assert.ok(s.indexOf('if (paidOrders > 0)') < s.indexOf('Order.deleteMany'), 'refusal happens before deletion');
  });

  test('in-flight V1 consumption blocks the reset', () => {
    const s = route();
    assert.ok(s.includes('Reservation.countDocuments({ status: "CONSUMING" })'), 'in-flight count');
    assert.ok(s.includes('if (consumingReservations > 0)'), 'CONSUMING preflight');
    assert.ok(s.includes('CLEAR_ORDERS_V1_CONSUMPTION_IN_FLIGHT'), 'stable refusal code');
    assert.ok(s.indexOf('if (consumingReservations > 0)') < s.indexOf('Order.deleteMany'), 'refusal before deletion');
  });

  test('only non-evidence orders are deleted; PAID/ARCHIVED are preserved', () => {
    const s = route();
    assert.ok(s.includes('PRESERVED_ORDER_STATUSES = Object.freeze(["PAID", "ARCHIVED"])'));
    assert.ok(s.includes('Order.deleteMany({ status: { $nin: PRESERVED_ORDER_STATUSES } })'));
    assert.ok(!s.includes('Order.deleteMany({})'), 'no unconditional wipe');
  });

  test('consumed reservations and StockMovement audit evidence are never deleted', () => {
    const s = routeCode();
    assert.ok(s.includes('Reservation.deleteMany({ status: { $nin: ["CONSUMED", "CONSUMING"] } })'), 'consumed holds preserved');
    assert.ok(s.includes('PRESERVED_RESERVATION_STATUSES = Object.freeze(["CONSUMED", "CONSUMING"])'));
    assert.ok(!/StockMovement/.test(s), 'stock ledger untouched');
    assert.ok(!/inventoryaudit/i.test(s), 'inventory audit untouched');
  });

  test('reservedStock is zeroed only after refusals, for remaining V1 holds', () => {
    const s = route();
    const consumingGate = s.indexOf('if (consumingReservations > 0)');
    const zeroing = s.indexOf('$set: { reservedStock: 0 }');
    assert.ok(zeroing > consumingGate, 'global release runs only after the in-flight refusal');
    assert.ok(s.includes('{ reservedStock: { $gt: 0 } }'), 'only positive holds are touched');
  });
});

describe('Phase 2.2 clear-orders counter and audit behavior', () => {
  test('order counter resets only when the collection is truly empty', () => {
    const s = route();
    assert.ok(s.includes('const remainingOrders = await Order.countDocuments({});'));
    assert.ok(s.includes('if (remainingOrders === 0)'), 'counter guard');
    const guard = s.indexOf('if (remainingOrders === 0)');
    const counter = s.indexOf('{ _id: "order_seq" }', guard);
    assert.ok(counter > guard, 'counter write is inside the empty guard');
    assert.ok(s.includes('counterReset = true;'));
  });

  test('execution is audit logged without secrets', () => {
    const s = route();
    assert.ok(s.includes('logEvent("warn", "clear_orders_executed"'));
    assert.ok(s.includes('managerStaffId: String(auth.payload.staffId || "")'));
    const logStart = s.indexOf('logEvent("warn", "clear_orders_executed"');
    const logEnd = s.indexOf('});', logStart);
    const logBlock = s.slice(logStart, logEnd);
    assert.ok(!/pin|password|secret|token/i.test(logBlock), 'audit event carries no credential');
  });

  test('response contract remains compatible', () => {
    const s = route();
    assert.ok(s.includes('ok({ clearedOrders: deleted.deletedCount'));
    for (const field of ['clearedOrders', 'clearedReservations', 'preservedOrders', 'counterReset']) {
      assert.ok(s.includes(field), `${field} returned`);
    }
  });
});
