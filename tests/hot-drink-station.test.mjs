// JEBENA BUNA third preparation station (HOT_DRINK) — DB-free proofs.
//
// Covers the full Phase B surface: role/auth provisioning, authorization
// matrix, menu catalog routing, order state machine + KDS projection, waiter
// tracking, payment boundaries, inventory isolation, reporting buckets,
// portals, and the opt-in catalog migration script.
//
// The suite is source/unit based (no MongoDB, no production writes), matching
// the existing station/policy test style.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAFF_ROLES } from '../lib/models/Staff.js';
import { SESSION_ROLES } from '../lib/models/Session.js';
import { ITEM_TYPE, OrderSchema } from '../lib/models/Order.js';
import { can, canTransition, GROUPS, ROLES } from '../lib/policy.js';
import { validateRole } from '../lib/validate.js';
import { DEFAULT_HOT_DRINK_PIN } from '../lib/config/security.js';
import { buildRevenueBreakdowns } from '../lib/reportRevenueBreakdown.js';
import { buildReport } from '../lib/analytics.js';
import { projectCashierReportResponse } from '../lib/cashierReport.js';
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
const exists = (p) => existsSync(join(root, p));

function itemAmount(item) {
  const base = (Number(item?.price) || 0) * (Number(item?.quantity) || 0);
  const comps = (Array.isArray(item?.components) ? item.components : [])
    .filter((c) => c.kind === 'PRICED_COMPONENT')
    .reduce((s, c) => s + (Number(c.lineSum) || 0), 0);
  return base + comps;
}

function paidOrder(id, totalAmount, items, extra = {}) {
  return {
    _id: id,
    orderNumber: id,
    status: 'PAID',
    createdAt: new Date('2026-10-01T09:00:00.000Z'),
    paymentMethod: 'CASH',
    totalAmount,
    items,
    ...extra,
  };
}

function breakdown(orders) {
  return buildRevenueBreakdowns(orders, {
    effectiveOrderAmount: (o) => Number(o.totalAmount) || 0,
    activeItemAmount: itemAmount,
  });
}

describe('HOT_DRINK authentication and provisioning', () => {
  test('role enums accept HOT_DRINK everywhere auth reads them', () => {
    assert.ok(STAFF_ROLES.includes('HOT_DRINK'), 'Staff role enum');
    assert.ok(SESSION_ROLES.includes('HOT_DRINK'), 'Session roleSnapshot enum');
    assert.equal(validateRole('hot_drink'), 'HOT_DRINK', 'role validator normalizes');
    assert.equal(validateRole('HOT_DRINK'), 'HOT_DRINK');
  });

  test('login is role-generic: verify-pin looks up live Staff by role', () => {
    const route = src('app/api/auth/verify-pin/route.js');
    assert.ok(route.includes('Staff.find({ role, isActive: { $ne: false } })'), 'live Staff lookup by role excludes disabled accounts');
    assert.ok(route.includes('validateRole(body.role)'), 'role validated by the shared validator');
    assert.ok(!/role === "HOT_DRINK"/.test(route), 'no duplicate HOT_DRINK auth branch');
  });

  test('DEFAULT_HOT_DRINK_PIN is env-overridable, 4 digits, scrypt-hashed at rest', () => {
    assert.match(DEFAULT_HOT_DRINK_PIN, /^\d{4}$/);
    const security = src('lib/config/security.js');
    assert.ok(security.includes('DEFAULT_HOT_DRINK_PIN = process.env.DEFAULT_HOT_DRINK_PIN || "5555"'));
    const seed = src('scripts/seed-hot-drink-staff.mjs');
    assert.ok(seed.includes('hashPin(DEFAULT_HOT_DRINK_PIN)'), 'never stores plaintext PIN');
    assert.ok(seed.includes('Staff.find({ role: ROLE })'), 'idempotent presence check');
    assert.ok(seed.includes('--reset-pin'), 'explicit opt-in PIN reset');
    assert.ok(seed.includes('already present'), 'existing account is not overwritten by default');
  });

  test('manager role-wide PIN reset covers HOT_DRINK and revokes its sessions', () => {
    const route = src('app/api/manager/staff/route.js');
    assert.ok(route.includes('isRoleWidePinRole(targetRole)'), 'station role-wide reset is policy-driven');
    assert.ok(src('lib/staffPinPolicy.js').includes('ROLE_WIDE_PIN_ROLES = Object.freeze(["KITCHEN", "BARISTA", "HOT_DRINK"])'), 'HOT_DRINK remains role-wide');
    assert.ok(route.includes('revokeRoleSessions(conn, targetRole, "PIN_RESET")'));
    const staff = src('app/api/staff/route.js');
    assert.ok(staff.includes('HOT_DRINK: DEFAULT_HOT_DRINK_PIN'), 'default/custom PIN status map');
  });
});

describe('HOT_DRINK authorization boundaries', () => {
  test('station role may prepare, mark ready, archive own station, cancel own line', () => {
    assert.equal(can('HOT_DRINK', 'orders:transition:PREPARING'), true);
    assert.equal(can('HOT_DRINK', 'orders:transition:READY'), true);
    assert.equal(canTransition('HOT_DRINK', 'ARCHIVED'), true);
    assert.equal(can('HOT_DRINK', 'orders:cancel:item'), true);
    assert.equal(can('HOT_DRINK', 'orders:read'), true);
  });

  test('station role cannot serve, pay, cancel the order, or mutate management data', () => {
    assert.equal(canTransition('HOT_DRINK', 'SERVED'), false);
    assert.equal(canTransition('HOT_DRINK', 'PAYMENT_PENDING'), false);
    assert.equal(canTransition('HOT_DRINK', 'PAID'), false);
    assert.equal(can('HOT_DRINK', 'orders:create'), false);
    assert.equal(can('HOT_DRINK', 'orders:payment:submit'), false);
    assert.equal(can('HOT_DRINK', 'orders:payment:confirm'), false);
    assert.equal(can('HOT_DRINK', 'menu:mutate'), false);
    assert.equal(can('HOT_DRINK', 'staff:mutate'), false);
    assert.equal(can('HOT_DRINK', 'reports:read'), false);
    assert.equal(can('HOT_DRINK', 'inventory:mutate'), false);
  });

  test('HOT_DRINK group is explicit and scoped to the station + manager', () => {
    assert.deepEqual(GROUPS.HOT_DRINK_OR_MANAGER, [ROLES.HOT_DRINK, ROLES.MANAGER]);
    assert.equal(stationForRole('HOT_DRINK'), 'HOT_DRINK');
    assert.equal(stationForRole('MANAGER'), null);
    assert.equal(stationForRole('CASHIER'), null);
  });
});

describe('HOT_DRINK menu catalog routing', () => {
  test('explicit station/type resolves to HOT_DRINK; historical coffee stays BARISTA', () => {
    const menu = src('lib/menuService.js');
    assert.ok(menu.includes('HOT_DRINK: "HOT_DRINK"'), 'STATIONS/CATEGORY_TYPES include the third value');
    assert.ok(menu.includes('if (cat.targetStation === "HOT_DRINK") return STATIONS.HOT_DRINK;'));
    assert.ok(menu.includes('if (cat.type === "HOT_DRINK") return STATIONS.HOT_DRINK;'));
    // Ordering: explicit HOT_DRINK checks precede the legacy coffee/barista
    // heuristic, and the heuristic itself is unchanged (no implicit retarget).
    const hotAt = menu.indexOf('if (cat.targetStation === "HOT_DRINK")');
    const coffeeAt = menu.indexOf('if (/drink|barista|juice|coffee|beer|wine/i.test');
    assert.ok(hotAt > -1 && coffeeAt > -1 && hotAt < coffeeAt, 'explicit HOT_DRINK wins over heuristics');
    assert.ok(menu.includes('return STATIONS.BARISTA;'), 'historical coffee default stays BARISTA');
  });

  test('catalog models persist the third enum value', () => {
    const category = src('lib/models/Category.js');
    const menuItem = src('lib/models/MenuItem.js');
    assert.ok(category.includes('enum: ["FOOD", "DRINK", "HOT_DRINK"]'));
    assert.ok(category.includes('enum: ["KITCHEN", "BARISTA", "HOT_DRINK"]'));
    assert.ok(menuItem.includes('enum: ["FOOD", "DRINK", "HOT_DRINK"]'));
    assert.ok(menuItem.includes('enum: ["KITCHEN", "BARISTA", "HOT_DRINK"]'));
  });

  test('menu CRUD has a first-class HOT_DRINK tab and write path', () => {
    const actions = src('app/manager/menu-crud/actions.js');
    assert.ok(actions.includes('function stationType(station)'));
    assert.ok(actions.includes('rawStation === "HOT_DRINK"'));
    assert.ok(actions.includes('type: stationType(targetStation)'));
    const client = src('app/manager/menu-crud/MenuCrudClient.jsx');
    assert.ok(client.includes("handleTabChange('HOT_DRINK')"));
    assert.ok(client.includes('stationType(activeTab)'));
    assert.ok(client.includes('stationOfCategory') && client.includes('stationOfItem'));
  });
});

describe('HOT_DRINK order state machine', () => {
  test('item type and station fields are additive and nullable', () => {
    assert.deepEqual(ITEM_TYPE, ['FOOD', 'DRINK', 'HOT_DRINK']);
    assert.ok(OrderSchema.path('hotDrinkStatus'), 'hotDrinkStatus path');
    assert.ok(OrderSchema.path('hotDrinkStaffId'), 'hotDrinkStaffId path');
    assert.ok(OrderSchema.path('hotDrinkPreparingAt'), 'hotDrinkPreparingAt path');
    assert.ok(OrderSchema.path('hotDrinkReadyAt'), 'hotDrinkReadyAt path');
    assert.deepEqual(OrderSchema.path('hotDrinkStatus').enumValues, [
      'PENDING',
      'PREPARING',
      'READY',
      'SERVED',
      'PAYMENT_PENDING',
      'PAID',
      'CANCELLED',
      'ARCHIVED',
    ]);
    assert.ok(OrderSchema.path('items').schema.path('cancelledStation').enumValues.includes('HOT_DRINK'));
  });

  test('order service treats HOT_DRINK as a peer station, not a DRINK alias', () => {
    const svc = src('lib/orderService.js');
    assert.ok(svc.includes('const isHotDrink = role === "HOT_DRINK"'));
    assert.ok(svc.includes('hasHotDrinkExpr'));
    assert.ok(svc.includes('hotDrinkStatus: { $cond: ["$__updateHotDrink", status, "$hotDrinkStatus"] }'));
    assert.ok(svc.includes('hotDrinkStaffId: hAttrExpr'));
    assert.ok(svc.includes('hotDrinkPreparingAt'));
    assert.ok(svc.includes('hotDrinkReadyAt'));
    assert.ok(svc.includes('order has no active HOT_DRINK items for Jebena Buna'));
    assert.ok(svc.includes('Jebena Buna can only cancel HOT_DRINK items'));
  });

  test('overall READY requires every present active station', () => {
    const svc = src('lib/orderService.js');
    assert.ok(svc.includes('$not: ["$__hasFood"]'));
    assert.ok(svc.includes('$not: ["$__hasDrink"]'));
    assert.ok(svc.includes('$not: ["$__hasHotDrink"]'));
    assert.ok(svc.includes('$eq: ["$hotDrinkStatus", "READY"]'));
  });

  test('KDS projection exposes hot-drink status, timestamps and attribution', () => {
    const svc = src('lib/orderService.js');
    const shapeStart = svc.indexOf('export function toKdsShape(order)');
    assert.ok(shapeStart > -1);
    const shape = svc.slice(shapeStart);
    assert.ok(shape.includes('hotDrinkStaffId: order.hotDrinkStaffId ? String(order.hotDrinkStaffId) : null'));
    assert.ok(shape.includes('hotDrinkStatus: order.hotDrinkStatus || null'));
    assert.ok(shape.includes('hotDrinkPreparingAt: order.hotDrinkPreparingAt'));
    assert.ok(shape.includes('hotDrinkReadyAt: order.hotDrinkReadyAt'));
    assert.ok(shape.includes('type: i.type'), 'line type snapshot is preserved verbatim');
    assert.ok(shape.includes('cancelledStation: i.cancelledStation || null'));
  });
});

describe('HOT_DRINK station model and waiter tracking', () => {
  test('pure station helpers support the third station without touching the other two', () => {
    const order = {
      status: 'PENDING',
      kitchenStatus: null,
      baristaStatus: null,
      hotDrinkStatus: null,
      items: [
        { lineId: 'f', type: 'FOOD', cancelled: false },
        { lineId: 'd', type: 'DRINK', cancelled: false },
        { lineId: 'h', type: 'HOT_DRINK', cancelled: false },
      ],
    };
    assert.equal(stationForView('HOT_DRINK'), 'HOT_DRINK');
    assert.equal(hasActiveStationLines(order, 'HOT_DRINK'), true);
    assert.equal(stationActionOf(order, 'HOT_DRINK'), 'START_PREP');
    const next = applyStationUpdate(order, 'HOT_DRINK', 'PREPARING');
    assert.equal(next.hotDrinkStatus, 'PREPARING');
    assert.equal(next.kitchenStatus, null, 'kitchen untouched');
    assert.equal(next.baristaStatus, null, 'barista untouched');
    assert.equal(next.status, 'PENDING', 'overall remains server-derived');
    assert.equal(stationActionOf(next, 'HOT_DRINK'), 'MARK_READY');
    assert.equal(stationActionOf(next, 'KITCHEN'), 'START_PREP');
    assert.equal(stationActionOf(next, 'BARISTA'), 'START_PREP');
  });

  test('cancelled hot-drink lines create no station work', () => {
    const order = {
      hotDrinkStatus: null,
      items: [{ lineId: 'h', type: 'HOT_DRINK', cancelled: true }],
    };
    assert.equal(hasActiveStationLines(order, 'HOT_DRINK'), false);
    assert.equal(stationActionOf(order, 'HOT_DRINK'), null);
    assert.equal(stationStatusOf(order, 'HOT_DRINK'), 'PENDING');
  });

  test('waiter UI classifies HOT_DRINK and shows all present station chips', () => {
    const ui = src('app/components/WaiterUI.js');
    assert.ok(ui.includes('item.targetStation === "HOT_DRINK"'));
    assert.ok(ui.includes('o.hotDrinkStatus'));
    assert.ok(ui.includes('stations.length < 2'), 'mixed chips only for multi-station orders');
    assert.ok(ui.includes("key: 'hotDrink'"));
  });

  test('JEBENA board reuses KitchenDisplay with a scoped dest and label', () => {
    const board = src('app/components/KitchenDisplay.js');
    assert.ok(board.includes("view === 'HOT_DRINK' ? 'HOT_DRINK'"), 'dest-scoped fetch');
    assert.ok(board.includes("t('emptySubHotDrink')"));
    assert.ok(board.includes("'hotDrinkOnly'"));
    assert.ok(board.includes("view === 'HOT_DRINK' ? '/jebena'"), 'session re-login route');
    assert.ok(board.includes('pending.station === \'HOT_DRINK\''), 'optimistic merge is station-aware');
  });
});

describe('HOT_DRINK payment and inventory boundaries', () => {
  test('payment remains outside station authority', () => {
    assert.equal(canTransition('HOT_DRINK', 'PAID'), false);
    assert.equal(can('HOT_DRINK', 'orders:payment'), false);
    const pay = src('app/api/orders/[id]/route.js');
    assert.ok(pay.includes('orders:payment:confirm'), 'cashier/manager confirm gate unchanged');
    assert.ok(!pay.includes('role === "HOT_DRINK" &&'), 'station role is not added to payment branches');
  });

  test('hot-drink lines are included in the paid amount (no payment regression)', () => {
    const result = breakdown([
      paidOrder('hot-mixed', 100, [
        { type: 'FOOD', price: 30, quantity: 1 },
        { type: 'DRINK', price: 20, quantity: 1 },
        { type: 'HOT_DRINK', price: 50, quantity: 1 },
      ]),
    ]);
    assert.equal(result.foodRevenue, 30);
    assert.equal(result.drinkRevenue, 20);
    assert.equal(result.hotDrinkRevenue, 50);
    assert.equal(result.unattributedRevenue, 0);
    assert.equal(result.paymentBreakdown[0].amount, 100);
  });

  test('D-6: HOT_DRINK does not join inventory waste/audit actor allowlists', () => {
    for (const file of ['lib/inventoryWasteService.js', 'lib/inventoryAuditService.js']) {
      if (!exists(file)) continue;
      assert.ok(!src(file).includes('HOT_DRINK'), `${file} stays unchanged (no station role grant)`);
    }
  });
});

describe('HOT_DRINK reporting buckets (D-3)', () => {
  test('revenue splits FOOD/DRINK/HOT_DRINK and keeps unattributed explicit', () => {
    const result = breakdown([
      paidOrder('hot-1', 100, [{ type: 'HOT_DRINK', price: 100, quantity: 1 }]),
      paidOrder('mixed-1', 100, [
        { type: 'FOOD', price: 40, quantity: 1 },
        { type: 'DRINK', price: 20, quantity: 1 },
        { type: 'HOT_DRINK', price: 30, quantity: 1 },
        { type: 'OTHER', price: 10, quantity: 1 },
      ]),
      paidOrder('legacy-1', 50, [
        { categoryType: 'HOT_DRINK', price: 25, quantity: 2 },
      ]),
    ]);
    assert.equal(result.foodRevenue, 40);
    assert.equal(result.drinkRevenue, 20);
    assert.equal(result.hotDrinkRevenue, 180);
    assert.equal(result.unattributedRevenue, 10);
    assert.equal(
      result.foodRevenue + result.drinkRevenue + result.hotDrinkRevenue + result.unattributedRevenue,
      250,
      'buckets reconcile to the canonical paid total'
    );
  });

  test('historical FOOD/DRINK reports keep their exact prior numbers', () => {
    const result = breakdown([
      paidOrder('legacy', 100, [
        { type: 'FOOD', price: 60, quantity: 1 },
        { type: 'DRINK', price: 40, quantity: 1 },
      ]),
    ]);
    assert.equal(result.foodRevenue, 60);
    assert.equal(result.drinkRevenue, 40);
    assert.equal(result.hotDrinkRevenue, 0);
    assert.equal(result.unattributedRevenue, 0);
  });

  test('manager analytics exposes hotDrinkRevenue without changing paid revenue', () => {
    const from = new Date('2026-10-01T00:00:00.000Z');
    const to = new Date('2026-10-02T00:00:00.000Z');
    const report = buildReport([
      paidOrder('r1', 100, [{ type: 'HOT_DRINK', price: 100, quantity: 1 }]),
    ], from, to, 'daily');
    assert.equal(report.kpis.revenue, 100);
    assert.equal(report.kpis.hotDrinkRevenue, 100);
    assert.equal(report.kpis.foodRevenue, 0);
    assert.equal(report.kpis.drinkRevenue, 0);
    assert.equal(report.kpis.unattributedItemRevenue, 0);
    const analytics = src('lib/analytics.js');
    assert.ok(analytics.includes('hotDrinkRevenue: revenueBreakdowns.hotDrinkRevenue'));
  });

  test('cashier projection carries the third bucket; reports UI renders it', () => {
    const projected = projectCashierReportResponse({ kpis: { revenue: 10, foodRevenue: 4, drinkRevenue: 3, hotDrinkRevenue: 2, unattributedItemRevenue: 1 } }, []);
    assert.deepEqual(projected.revenue, { total: 10, food: 4, drink: 3, hotDrink: 2, unattributed: 1 });
    const cashier = src('app/components/CashierUI.jsx');
    assert.ok(cashier.includes("t('hotDrinkRevenue')"));
    assert.ok(cashier.includes("hotDrinkReportItems"));
    const manager = src('app/manager/reports/page.js');
    assert.ok(manager.includes("t('hotDrinkRevenue')"));
    assert.ok(manager.includes('hotDrinkMenuPerformance'));
  });
});

describe('JEBENA BUNA portals and migration script', () => {
  test('portal route is guarded by the live HOT_DRINK session', () => {
    assert.ok(exists('app/jebena/layout.js'));
    assert.ok(exists('app/jebena/page.js'));
    const layout = src('app/jebena/layout.js');
    assert.ok(layout.includes('getPortalSession("HOT_DRINK")'));
    assert.ok(layout.includes('<PinGuard role="HOT_DRINK" next="/jebena" />'));
    const page = src('app/jebena/page.js');
    assert.ok(page.includes('station="HOT_DRINK"'));
    assert.ok(page.includes('stationLabel="JEBENA BUNA ONLY"'));
  });

  test('login/home/PIN surfaces know /jebena', () => {
    assert.ok(src('app/login/page.js').includes('next.startsWith("/jebena")'));
    assert.ok(src('app/login/page.js').includes('return "HOT_DRINK"'));
    assert.ok(src('app/components/HomeNav.jsx').includes('route: "/jebena"'));
    assert.ok(src('app/components/HomeNav.jsx').includes('hotDrinkPortal'));
    assert.ok(src('app/components/PinGuard.js').includes('HOT_DRINK: "Jebena Buna Display"'));
    assert.ok(src('app/components/PinLoginModal.js').includes('HOT_DRINK: <IconCoffee'));
  });

  test('migration is read-only by default, opt-in with --apply, and never touches orders', () => {
    const script = src('scripts/migrate-hot-drink-station.mjs');
    assert.ok(script.includes('--apply'));
    assert.ok(script.includes('DRY RUN'));
    assert.ok(script.includes('HOT_BEVERAGE_RE'));
    assert.ok(script.includes('targetStation: "HOT_DRINK"'));
    assert.ok(script.includes('station: "HOT_DRINK"'));
    assert.ok(script.includes('categoryType: "HOT_DRINK"'));
    assert.ok(script.includes('Orders (never modified)'));
    assert.ok(!/orders"\)\.update|orders"\)\.updateMany|collection\("orders"\)\.update/.test(script));
  });
});
