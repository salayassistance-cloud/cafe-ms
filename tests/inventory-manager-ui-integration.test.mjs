// tests/inventory-manager-ui-integration.test.mjs
//
// Focused regression test suite for Inventory Manager UI integration:
// 1. StockMovement serialization (unit, unitCost, totalCost)
// 2. /api/inventory/movements projection & route contracts
// 3. M5 recipe 3-decimal precision validation (backend + UI)
// 4. Inventory classification (TRACKED, UNTRACKED) partitioning & policy
// 5. Stock Policy A shortage blocking contract (no Manager override)
// 6. UI source integrity (movements tab, classification filter, report condition)
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeMovement } from '../lib/inventoryService.js';
import { validateRecipeCreate, validateRecipeUpdate } from '../lib/recipeValidation.js';
import {
  isTrackedRecipeUsable,
  resolveSavedMenuItemPolicy,
} from '../lib/inventoryPolicy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const exists = (p) => existsSync(join(root, p));

describe('Inventory Manager UI Integration — Stock Movements Serialization', () => {
  test('serializeMovement includes unit, unitCost, and totalCost when populated', () => {
    const raw = {
      _id: '507f1f77bcf86cd799439011',
      item: '507f1f77bcf86cd799439012',
      type: 'IN',
      quantity: 25.5,
      unit: 'kg',
      unitCost: 120.75,
      totalCost: 3079.125,
      reason: 'PO #4421',
      createdBy: '507f1f77bcf86cd799439013',
      refOrderId: null,
      createdAt: new Date('2026-11-15T10:00:00Z'),
    };

    const out = serializeMovement(raw);
    assert.equal(out.id, '507f1f77bcf86cd799439011');
    assert.equal(out.item, '507f1f77bcf86cd799439012');
    assert.equal(out.type, 'IN');
    assert.equal(out.quantity, 25.5);
    assert.equal(out.unit, 'kg');
    assert.equal(out.unitCost, 120.75);
    assert.equal(out.totalCost, 3079.125);
    assert.equal(out.reason, 'PO #4421');
    assert.equal(out.refOrderId, null);
  });

  test('serializeMovement safely falls back to null for missing or non-finite costs and units', () => {
    const raw = {
      _id: '507f1f77bcf86cd799439021',
      item: '507f1f77bcf86cd799439022',
      type: 'OUT',
      quantity: 5,
      unit: '',
      unitCost: null,
      totalCost: undefined,
      reason: 'Waste',
      createdBy: null,
      refOrderId: '507f1f77bcf86cd799439023',
    };

    const out = serializeMovement(raw);
    assert.equal(out.unit, null);
    assert.equal(out.unitCost, null);
    assert.equal(out.totalCost, null);
    assert.equal(out.refOrderId, '507f1f77bcf86cd799439023');
  });

  test('serializeMovement casts string costs to finite numbers or null', () => {
    const validStr = serializeMovement({
      _id: '507f1f77bcf86cd799439031',
      quantity: 2,
      unitCost: '45.50',
      totalCost: '91.00',
    });
    assert.equal(validStr.unitCost, 45.5);
    assert.equal(validStr.totalCost, 91.0);

    const invalidStr = serializeMovement({
      _id: '507f1f77bcf86cd799439032',
      quantity: 2,
      unitCost: 'not-a-number',
      totalCost: NaN,
    });
    assert.equal(invalidStr.unitCost, null);
    assert.equal(invalidStr.totalCost, null);
  });
});

describe('Inventory Manager UI Integration — Movements Route Contract', () => {
  const routeSource = src('app/api/inventory/movements/route.js');

  test('movements route projects unit, unitCost, totalCost, voidedAt, voidReason', () => {
    assert.ok(
      routeSource.includes('unit unitCost totalCost'),
      'route includes projected unit and cost fields'
    );
    assert.ok(
      routeSource.includes('voidedAt voidReason'),
      'route includes projected void fields'
    );
  });

  test('movements route enforces MANAGER role authentication', () => {
    assert.ok(
      routeSource.includes('requireAuth(request, ["MANAGER"])'),
      'requires MANAGER authorization'
    );
  });

  test('movements route supports query filters for itemId and movement type', () => {
    assert.ok(routeSource.includes('searchParams.get("itemId")'), 'supports itemId filter');
    assert.ok(routeSource.includes('searchParams.get("type")'), 'supports type filter');
    assert.ok(routeSource.includes('["IN", "OUT", "ADJUSTMENT"].includes(st)'), 'validates movement types');
  });
});

describe('Inventory Manager UI Integration — M5 3-Decimal Precision Validation', () => {
  const validObjectId = '507f1f77bcf86cd799439011';
  const validItemId = '507f1f77bcf86cd799439012';

  test('validateRecipeCreate accepts valid quantities with up to 3 decimal places', () => {
    const validCases = [1, 0.5, 0.25, 0.125, 0.001, 10.005];
    for (const qty of validCases) {
      const res = validateRecipeCreate({
        menuItemId: validObjectId,
        ingredients: [{ inventoryItemId: validItemId, quantity: qty, unit: 'kg' }],
      });
      assert.equal(res.ok, true, `Expected quantity ${qty} to be valid`);
      assert.equal(res.data.ingredients[0].quantity, qty);
    }
  });

  test('validateRecipeCreate rejects quantities exceeding 3 decimal places', () => {
    const invalidCases = [0.0005, 0.0001, 1.2345, 0.123456];
    for (const qty of invalidCases) {
      const res = validateRecipeCreate({
        menuItemId: validObjectId,
        ingredients: [{ inventoryItemId: validItemId, quantity: qty, unit: 'kg' }],
      });
      assert.equal(res.ok, undefined, `Expected quantity ${qty} to fail validation`);
      assert.ok(
        res.error.includes('cannot exceed 3 decimal places'),
        `Expected 3 decimal places error, got: ${res.error}`
      );
    }
  });

  test('validateRecipeUpdate rejects quantities exceeding 3 decimal places', () => {
    const res = validateRecipeUpdate({
      ingredients: [{ inventoryItemId: validItemId, quantity: 0.0009, unit: 'L' }],
    });
    assert.equal(res.ok, undefined);
    assert.ok(res.error.includes('cannot exceed 3 decimal places'));
  });
});

describe('Inventory Manager UI Integration — Inventory Classification Partitioning', () => {
  // Classification is the canonical saved MenuItem inventoryPolicy, never
  // inferred from Recipe presence. Recipes are a separate health signal.
  // Extra Items are separate sellable add-ons linked to InventoryItem stock;
  // they are never classified as MenuItem catalog lines.

  const catalogMenuItems = [
    { _id: 'menu_001', name: 'Cappuccino', price: 80, inventoryPolicy: 'TRACKED' },
    { _id: 'menu_002', name: 'Black Coffee', price: 50, inventoryPolicy: 'TRACKED' },
    { _id: 'menu_003', name: 'Mineral Water', price: 30, inventoryPolicy: 'UNTRACKED' },
    { _id: 'menu_004', name: 'Special Burger', price: 250, inventoryPolicy: null },
  ];

  const savedPolicies = Object.fromEntries(
    catalogMenuItems.map((m) => [m._id, m.inventoryPolicy])
  );

  const recipes = [
    {
      _id: 'rec_001',
      menuItemId: 'menu_001',
      isActive: true,
      ingredients: [
        { inventoryItemId: 'inv_coffee', quantity: 0.018, unit: 'kg' },
        { inventoryItemId: 'inv_milk', quantity: 0.15, unit: 'L' },
      ],
    },
    {
      _id: 'rec_002',
      menuItemId: 'menu_002',
      isActive: true,
      ingredients: [{ inventoryItemId: 'inv_coffee', quantity: 0.015, unit: 'kg' }],
    },
    {
      _id: 'rec_003',
      menuItemId: 'menu_004',
      isActive: false,
      ingredients: [{ inventoryItemId: 'inv_patty', quantity: 1, unit: 'pcs' }],
    },
    // menu_003 has no recipe at all, and stays UNTRACKED because it is saved so.
  ];

  const classificationOf = (m) => resolveSavedMenuItemPolicy(savedPolicies, m._id);

  test('partition catalog by saved policy into TRACKED / UNTRACKED / UNKNOWN', () => {
    const tracked = catalogMenuItems.filter((m) => classificationOf(m) === 'TRACKED');
    const untracked = catalogMenuItems.filter((m) => classificationOf(m) === 'UNTRACKED');
    const unknown = catalogMenuItems.filter((m) => classificationOf(m) === 'UNKNOWN');

    assert.deepEqual(tracked.map((m) => m.name), ['Cappuccino', 'Black Coffee']);
    assert.deepEqual(untracked.map((m) => m.name), ['Mineral Water']);
    // A legacy null item with an inactive Recipe is explicit UNKNOWN.
    assert.deepEqual(unknown.map((m) => m.name), ['Special Burger']);
  });

  test('a saved UNTRACKED item with an active Recipe stays UNTRACKED', () => {
    const withRecipe = [
      ...recipes,
      {
        _id: 'rec_004',
        menuItemId: 'menu_003',
        isActive: true,
        ingredients: [{ inventoryItemId: 'inv_water', quantity: 1, unit: 'L' }],
      },
    ];
    assert.ok(withRecipe.some((r) => r.menuItemId === 'menu_003'));
    assert.equal(classificationOf(catalogMenuItems[2]), 'UNTRACKED');
  });

  test('a saved TRACKED item with a broken Recipe stays TRACKED and is flagged', () => {
    const broken = { ...recipes[0], isActive: false, ingredients: [] };
    assert.equal(classificationOf(catalogMenuItems[0]), 'TRACKED');
    assert.equal(isTrackedRecipeUsable(broken), false);
  });

  test('legacy isExternal lines remain readable but are not a classification bucket', () => {
    // Historical documents may still carry isExternal: true. New code treats
    // every order line as a catalog line (with or without a recipe).
    const orderItems = [
      { menuItemId: 'menu_001', name: 'Cappuccino', isExternal: false },
      { menuItemId: 'menu_005', name: 'Mineral Water', isExternal: false },
    ];
    assert.equal(orderItems.filter((it) => it.isExternal === true).length, 0);
  });

  test('unresolved policy is never silently auto-classified as TRACKED', () => {
    assert.equal(resolveSavedMenuItemPolicy({}, 'menu_missing'), 'UNKNOWN');
    assert.equal(
      resolveSavedMenuItemPolicy({ menu_001: 'UNKNOWN' }, 'menu_001'),
      'UNKNOWN'
    );
    assert.equal(
      catalogMenuItems.filter((m) => classificationOf(m) === 'TRACKED').length,
      2
    );
  });
});

describe('Inventory Manager UI Integration — Stock Policy A Shortage Blocking', () => {
  const reservationService = src('lib/inventoryReservationService.js');

  test('removed approval routes stay absent', () => {
    assert.equal(exists('app/api/orders/[id]/inventory-approval/route.js'), false);
    assert.equal(exists('app/api/manager/inventory-approvals/route.js'), false);
  });

  test('shortage writes INSUFFICIENT_STOCK and never MANAGER_APPROVAL_REQUIRED', () => {
    assert.ok(reservationService.includes('"INSUFFICIENT_STOCK"'));
    assert.equal(reservationService.includes('MANAGER_APPROVAL_REQUIRED'), false);
    assert.equal(reservationService.includes('approveInventoryShortage'), false);
  });

  test('preparation and payment both block a shortage', () => {
    assert.ok(reservationService.includes('Preparation is blocked until stock is available'));
    assert.ok(reservationService.includes('Payment is blocked until stock is available'));
  });
});

describe('Inventory Manager UI Integration — UI Component Integrity', () => {
  const uiSource = src('app/components/InventoryUI.jsx');

  test('InventoryUI includes the six active navigation tabs (no Approvals tab)', () => {
    assert.ok(uiSource.includes("{ key: 'stock', label: 'Stock' }"), 'has stock tab');
    assert.ok(uiSource.includes("{ key: 'extras', label: 'Extra Items' }"), 'has Extra Items tab');
    assert.ok(uiSource.includes("{ key: 'movements', label: 'Movements' }"), 'has movements tab');
    assert.ok(uiSource.includes("{ key: 'suppliers', label: 'Suppliers' }"), 'has suppliers tab');
    assert.ok(uiSource.includes("{ key: 'recipes', label: 'Recipes' }"), 'has recipes tab');
    assert.ok(uiSource.includes("{ key: 'reports', label: 'Reports' }"), 'has reports tab');
    assert.equal(uiSource.includes("{ key: 'approvals'"), false, 'approvals tab removed');
  });

  test('InventoryUI separates the four physical stock areas', () => {
    assert.ok(uiSource.includes('STOCK_GROUP_FILTERS'), 'renders stock area filter chips');
    assert.ok(uiSource.includes("activeTab === 'extras'"), 'renders the Extra Items tab explicitly');
    assert.ok(uiSource.includes('stockGroupFilter'), 'filters the stock table by stock group');
    assert.ok(uiSource.includes('stockGroupLabel(row.stockGroup)'), 'shows each row stock area');
    assert.ok(uiSource.includes('name="stockGroup"') || uiSource.includes('stockGroup: e.target.value'), 'edits stockGroup on stock items');
  });

  test('InventoryUI Extra Items CRUD is manager-facing and price-aware', () => {
    assert.ok(uiSource.includes('/api/extra-items'), 'loads manager Extra Items');
    assert.ok(uiSource.includes('handleAddExtra'), 'creates Extra Items');
    assert.ok(uiSource.includes('handleEditExtra'), 'edits Extra Items');
    assert.ok(uiSource.includes('handleDeleteExtra'), 'deletes Extra Items');
    assert.ok(uiSource.includes('invSellingPrice'), 'separates selling price from stock cost');
    assert.ok(uiSource.includes('invLinkedStock'), 'shows the linked canonical stock item');
  });

  test('InventoryUI renders dedicated Movements and Audit views for activeTab === "movements"', () => {
    assert.ok(
      uiSource.includes("activeTab === 'movements'"),
      'handles activeTab === "movements" explicitly'
    );
    assert.ok(
      uiSource.includes("movementSubTab === 'movements'"),
      'supports movements sub-tab'
    );
    assert.ok(
      uiSource.includes("movementSubTab === 'audits'"),
      'supports audit trail sub-tab'
    );
  });

  test('InventoryUI classification filter has no EXTERNAL bucket', () => {
    assert.ok(
      uiSource.includes("recipeClassificationFilter === 'ALL'"),
      'has ALL classification filter'
    );
    assert.ok(
      uiSource.includes("recipeClassificationFilter === 'TRACKED'"),
      'has TRACKED classification filter'
    );
    assert.ok(
      uiSource.includes("recipeClassificationFilter === 'UNTRACKED'"),
      'has UNTRACKED classification filter'
    );
    assert.ok(
      uiSource.includes("recipeClassificationFilter === 'UNKNOWN'"),
      'has explicit UNKNOWN classification filter'
    );
    assert.equal(
      uiSource.includes("recipeClassificationFilter === 'EXTERNAL'"),
      false,
      'EXTERNAL classification filter removed'
    );
  });

  test('InventoryUI no longer renders an external item policy card', () => {
    assert.equal(uiSource.includes('External / Ad-hoc Item Inventory Policy'), false);
    assert.equal(uiSource.includes('isExternal: true'), false);
  });

  test('InventoryUI enforces 3-decimal precision validation on recipe quantity inputs', () => {
    assert.ok(
      uiSource.includes('parts[1].length > 3'),
      'rejects client-side ingredient quantities with > 3 decimals'
    );
    assert.ok(
      uiSource.includes('invErrPrecision3'),
      'uses translated error key for precision error'
    );
  });

  test('InventoryUI uses controlled unit selects at all five write points', () => {
    const controls = (uiSource.match(/<UnitSelect\b/g) || []).length;
    assert.equal(controls, 5, 'receive, add item, edit item, create recipe, edit recipe');
    assert.ok(uiSource.includes('INVENTORY_UNIT_OPTIONS.map'), 'options come from the shared vocabulary');
    assert.ok(uiSource.includes("from '@/lib/inventoryUnitGuard'"), 'uses the authoritative unit guard');
    assert.ok(uiSource.includes('isValidInventoryUnit'), 'client-side validation is supplementary');
    assert.ok(uiSource.includes('legacy / invalid'), 'unsupported stored units are visibly flagged');
    assert.equal(
      /<input[^>]*value=\{(?:addForm|editForm|receiveForm)\.unit\}/.test(uiSource),
      false,
      'no free-text item unit inputs remain'
    );
    assert.equal(
      /<input[^>]*value=\{row\.unit\}/.test(uiSource),
      false,
      'no free-text recipe ingredient unit inputs remain'
    );
  });

  test('InventoryUI guards reports tab explicitly and never falls through blindly', () => {
    assert.ok(
      uiSource.includes(") : activeTab === 'reports' ? ("),
      'explicit conditional for reports tab'
    );
    assert.ok(
      uiSource.includes(") : null}\n      </main>") || uiSource.includes(") : null}"),
      'safely terminates conditional rendering with null'
    );
  });
});
