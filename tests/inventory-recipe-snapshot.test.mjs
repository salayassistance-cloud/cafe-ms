// H1.3 — immutable Recipe snapshot + TRACKED fail-closed + edit catalog outage.
//
// DB-FREE ONLY. No MongoDB connection, no environment file, no network. The
// pre-write and deduction paths run against in-memory model stubs so the
// snapshot capture, snapshot consumption, D11 fail-closed behavior and the C1
// 503/404 split are exercised for real instead of only matching source text.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { addPolicyVersionSupport } from "./helpers/policy-version-fakes.mjs";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const { createOrder, editOrderItems } = await import("../lib/orderService.js");
const {
  prepareInventoryDeduction,
  TRACKED_RECIPE_MISSING_REASON,
  TRACKED_RECIPE_INACTIVE_REASON,
  TRACKED_RECIPE_EMPTY_REASON,
  TRACKED_RECIPE_SNAPSHOT_INVALID_REASON,
} = await import("../lib/inventoryDeductionService.js");
const {
  calculateRawRequirements,
  ensureOrderInventoryReservation,
} = await import("../lib/inventoryReservationService.js");

const TRACKED_ID = "507f1f77bcf86cd7994390d1";
const UNTRACKED_ID = "507f1f77bcf86cd7994390d2";
const UNKNOWN_ID = "507f1f77bcf86cd7994390d3";
const MISSING_ID = "507f1f77bcf86cd7994390d4";
const INV_A = "507f1f77bcf86cd7994390d5";
const INV_B = "507f1f77bcf86cd7994390d6";
const EXTRA_ID = "507f1f77bcf86cd7994390d7";
const STAFF_ID = "507f1f77bcf86cd7994390d8";

function chain(docs) {
  const q = {
    select() {
      return q;
    },
    session() {
      return q;
    },
    lean: async () => docs,
  };
  return q;
}

function menuItem(id, policy) {
  const doc = {
    _id: id,
    name: { en: `Item ${id.slice(-2)}` },
    price: 10,
    categoryType: "FOOD",
    station: "KITCHEN",
    targetStation: "KITCHEN",
    isAvailable: true,
    inStock: true,
  };
  if (policy !== undefined) doc.inventoryPolicy = policy;
  return doc;
}

function recipeFor(menuItemId, quantity = 3, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    menuItemId,
    isActive: true,
    ingredients: [{ inventoryItemId: INV_A, quantity, unit: "g" }],
    ...overrides,
  };
}

function legacyLine(itemId = UNKNOWN_ID) {
  return {
    lineId: new mongoose.Types.ObjectId(),
    name: "Legacy Dish",
    price: 5,
    quantity: 1,
    type: "FOOD",
    itemId: new mongoose.Types.ObjectId(itemId),
    components: [],
    cancelled: false,
  };
}

// ---------- createOrder / deduction stubs ----------

function makeCreateConn({ menuItems = [], recipes = [] } = {}) {
  const saved = [];
  const recipeState = { rows: recipes };
  const MenuItem = {
    find(filter) {
      const ids = (filter?._id?.$in || []).map(String);
      return chain(menuItems.filter((m) => ids.includes(String(m._id))));
    },
  };
  const Recipe = {
    find(filter) {
      const ids = (filter?.menuItemId?.$in || []).map(String);
      return chain(recipeState.rows.filter((r) => ids.includes(String(r.menuItemId))));
    },
  };
  const InventoryItem = {
    find(filter) {
      const ids = (filter?._id?.$in || []).map(String);
      const docs = [
        {
          _id: INV_A,
          name: "Flour",
          unit: "g",
          currentStock: 1000,
          reservedStock: 0,
          cost: 1,
        },
        {
          _id: INV_B,
          name: "Injera",
          unit: "pcs",
          currentStock: 1000,
          reservedStock: 0,
          cost: 1,
        },
      ];
      return chain(docs.filter((d) => ids.includes(String(d._id))));
    },
  };
  const reservations = [];
  const InventoryReservation = {
    findOne: () => chain(null),
    findOneAndUpdate(filter, update) {
      reservations.push(update?.$setOnInsert || update);
      return { lean: async () => update?.$setOnInsert || update };
    },
  };
  class FakeOrder {
    constructor(data) {
      Object.assign(this, data);
      this._id = new mongoose.Types.ObjectId();
    }
    async save() {
      saved.push(this);
      return this;
    }
  }
  const conn = {
    models: {
      Order: FakeOrder,
      MenuItem,
      Recipe,
      InventoryItem,
      InventoryReservation,
      OrderCounter: { findOneAndUpdate: async () => ({ seq: saved.length + 1 }) },
    },
  };
  addPolicyVersionSupport(conn);
  return { conn, saved, reservations, recipeState };
}

function orderPayload(itemId, quantity = 2) {
  return {
    tableNumber: 7,
    items: [{ itemId, name: "client name", price: 1, quantity, type: "FOOD" }],
  };
}

function makeDeductionConn({
  menuItems = [],
  recipes = [],
  recipeThrows = false,
} = {}) {
  return {
    models: {
      MenuItem: { find: () => chain(menuItems) },
      Recipe: {
        find() {
          if (recipeThrows) throw new Error("live recipe read must not happen");
          return chain(recipes);
        },
      },
      InventoryItem: {
        find: () =>
          chain([
            { _id: INV_A, name: "Flour", unit: "g", currentStock: 1000, reservedStock: 0, cost: 1 },
          ]),
      },
      InventoryReservation: {
        findOne: () => chain(null),
        findOneAndUpdate: (filter, update) => ({
          lean: async () => update?.$setOnInsert || update,
        }),
      },
    },
  };
}

function snapshotOrder({
  menuItemId = TRACKED_ID,
  quantity = 2,
  ingredients = [{ inventoryItemId: INV_A, quantity: 3, unit: "g" }],
} = {}) {
  return {
    _id: "507f1f77bcf86cd7994390e9",
    items: [{ itemId: menuItemId, name: "Dish", quantity, type: "FOOD" }],
    inventoryRecipeSnapshot: {
      capturedAt: new Date("2026-01-01T00:00:00Z"),
      recipes: [{ menuItemId, recipeId: null, ingredients }],
    },
  };
}

function legacyOrder(menuItemId, quantity = 2) {
  return {
    _id: "507f1f77bcf86cd7994390ea",
    items: [{ itemId: menuItemId, name: "Dish", quantity, type: "FOOD" }],
  };
}

// ---------- editOrderItems stub ----------

function makeEditConn({
  menuItems = [],
  recipes = [],
  menuFindThrows = false,
  existing = null,
} = {}) {
  const base = existing || {
    _id: new mongoose.Types.ObjectId(),
    status: "PENDING",
    waiterId: new mongoose.Types.ObjectId(STAFF_ID),
    items: [legacyLine()],
    totalAmount: 5,
    inventoryRecipeSnapshot: null,
  };
  const writes = [];
  const Order = {
    findOne() {
      return chain(base);
    },
    findOneAndUpdate(filter, update) {
      writes.push({ filter, update });
      return { ...base, ...(update?.$set || {}) };
    },
  };
  const MenuItem = {
    find(filter) {
      if (menuFindThrows) {
        throw new Error("server selection timed out; secret=do-not-leak");
      }
      const ids = (filter?._id?.$in || []).map(String);
      const found = menuItems.filter(
        (m) => ids.includes(String(m._id)) && m.isDeleted !== true
      );
      return chain(found);
    },
  };
  const Recipe = {
    find(filter) {
      const ids = (filter?.menuItemId?.$in || []).map(String);
      return chain(recipes.filter((r) => ids.includes(String(r.menuItemId))));
    },
  };
  const InventoryItem = {
    find: () =>
      chain([
        { _id: INV_A, name: "Flour", unit: "g", currentStock: 1000, reservedStock: 0, cost: 1 },
      ]),
  };
  const InventoryReservation = {
    findOne: () => chain(null),
    findOneAndUpdate: async () => ({ lean: async () => ({}) }),
    create: async (docs) => docs,
  };
  const conn = {
    models: {
      Order,
      MenuItem,
      Recipe,
      ExtraItem: { find: () => chain([]), findOne: () => chain(null) },
      InventoryItem,
      InventoryReservation,
    },
  };
  addPolicyVersionSupport(conn);
  return { conn, writes, existing: base };
}

async function addLine(conn, menuItemId, quantity = 1) {
  return editOrderItems(
    conn,
    "507f1f77bcf86cd7994390f9",
    [{ op: "add", menuItemId, quantity }],
    { staffRole: "MANAGER", staffId: STAFF_ID }
  );
}

// ---------- snapshot capture ----------

describe("H1.3: new TRACKED orders capture an immutable Recipe snapshot", () => {
  test("createOrder stores the active Recipe rows on the order", async () => {
    const { conn, saved } = makeCreateConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3)],
    });
    await createOrder(conn, orderPayload(TRACKED_ID, 2));
    assert.equal(saved.length, 1);
    const snapshot = saved[0].inventoryRecipeSnapshot;
    assert.ok(snapshot, "snapshot was captured");
    assert.ok(snapshot.capturedAt instanceof Date);
    const entry = snapshot.recipes.find((r) => String(r.menuItemId) === TRACKED_ID);
    assert.ok(entry, "TRACKED line captured");
    assert.equal(entry.ingredients.length, 1);
    assert.equal(entry.ingredients[0].quantity, 3);
    assert.equal(entry.ingredients[0].unit, "g");
  });

  test("a new order captures the LATEST active Recipe", async () => {
    const { conn, saved, recipeState } = makeCreateConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3)],
    });
    await createOrder(conn, orderPayload(TRACKED_ID, 1));
    recipeState.rows[0].ingredients[0].quantity = 7;
    await createOrder(conn, orderPayload(TRACKED_ID, 1));

    const first = saved[0].inventoryRecipeSnapshot.recipes[0].ingredients[0].quantity;
    const second = saved[1].inventoryRecipeSnapshot.recipes[0].ingredients[0].quantity;
    assert.equal(first, 3, "first order keeps its original capture");
    assert.equal(second, 7, "second order captures the current live Recipe");
  });

  test("an order with no TRACKED line stores no snapshot", async () => {
    const { conn, saved } = makeCreateConn({
      menuItems: [menuItem(UNTRACKED_ID, "UNTRACKED")],
      recipes: [recipeFor(UNTRACKED_ID, 3)],
    });
    await createOrder(conn, orderPayload(UNTRACKED_ID, 1));
    assert.equal(saved[0].inventoryRecipeSnapshot, null);
  });
});

// ---------- snapshot consumption ----------

describe("H1.3: deduction uses the captured snapshot, not the live Recipe", () => {
  test("a later live Recipe edit cannot change the captured requirement", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 99)],
    });
    const plan = await prepareInventoryDeduction(snapshotOrder(), { connection: conn });
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INV_A, quantity: 6, unit: "g" },
    ]);
    assert.deepEqual(plan.unresolved, []);
  });

  test("live Recipe deactivation cannot change the captured requirement", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3, { isActive: false })],
    });
    const plan = await prepareInventoryDeduction(snapshotOrder(), { connection: conn });
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INV_A, quantity: 6, unit: "g" },
    ]);
    assert.deepEqual(plan.unresolved, []);
  });

  test("a deleted live Recipe cannot change the captured requirement", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [],
    });
    const plan = await prepareInventoryDeduction(snapshotOrder(), { connection: conn });
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INV_A, quantity: 6, unit: "g" },
    ]);
    assert.deepEqual(plan.unresolved, []);
  });

  test("a captured order never reads the live Recipe at all", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipeThrows: true,
    });
    const raw = await calculateRawRequirements(conn, snapshotOrder());
    assert.deepEqual(raw.requirements, [
      { inventoryItemId: INV_A, unit: "g", requiredQuantity: 6 },
    ]);
    assert.deepEqual(raw.unresolved, []);
  });
});

// ---------- D11 fail-closed ----------

describe("H1.3 (D11): explicit TRACKED Recipes fail closed", () => {
  test("a missing Recipe is unresolved, never NO_INVENTORY", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [],
    });
    const raw = await calculateRawRequirements(conn, legacyOrder(TRACKED_ID));
    assert.deepEqual(raw.requirements, []);
    assert.ok(raw.unresolved.some((r) => r.startsWith(TRACKED_RECIPE_MISSING_REASON)));
  });

  test("an inactive Recipe is unresolved", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3, { isActive: false })],
    });
    const raw = await calculateRawRequirements(conn, legacyOrder(TRACKED_ID));
    assert.deepEqual(raw.requirements, []);
    assert.ok(raw.unresolved.some((r) => r.startsWith(TRACKED_RECIPE_INACTIVE_REASON)));
  });

  test("an empty Recipe is unresolved", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3, { ingredients: [] })],
    });
    const raw = await calculateRawRequirements(conn, legacyOrder(TRACKED_ID));
    assert.deepEqual(raw.requirements, []);
    assert.ok(raw.unresolved.some((r) => r.startsWith(TRACKED_RECIPE_EMPTY_REASON)));
  });

  test("a malformed live Recipe row is unresolved", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [
        recipeFor(TRACKED_ID, 3, {
          ingredients: [{ inventoryItemId: INV_A, quantity: 0, unit: "g" }],
        }),
      ],
    });
    const raw = await calculateRawRequirements(conn, legacyOrder(TRACKED_ID));
    assert.deepEqual(raw.requirements, []);
    assert.ok(raw.unresolved.some((r) => /invalid quantity/.test(r)));
  });

  test("a malformed captured Recipe is unresolved", async () => {
    const conn = makeDeductionConn({ menuItems: [menuItem(TRACKED_ID, "TRACKED")] });
    const plan = await prepareInventoryDeduction(
      snapshotOrder({ ingredients: [{ inventoryItemId: INV_A, quantity: 0, unit: "g" }] }),
      { connection: conn }
    );
    assert.deepEqual(plan.ingredients, []);
    assert.ok(
      plan.unresolved.some((r) => r.startsWith(TRACKED_RECIPE_SNAPSHOT_INVALID_REASON))
    );
  });

  test("the reservation layer persists a blocking unresolved state", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [],
    });
    const reservation = await ensureOrderInventoryReservation(
      conn,
      legacyOrder(TRACKED_ID)
    );
    assert.equal(reservation.status, "INSUFFICIENT_STOCK");
    assert.equal(reservation.unresolved, true);
    assert.deepEqual(reservation.items, []);
  });

  test("UNKNOWN legacy open orders keep the compatibility path", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(UNKNOWN_ID)],
      recipes: [recipeFor(UNKNOWN_ID, 3)],
    });
    const raw = await calculateRawRequirements(conn, legacyOrder(UNKNOWN_ID));
    assert.deepEqual(raw.requirements, [
      { inventoryItemId: INV_A, unit: "g", requiredQuantity: 6 },
    ]);
    assert.deepEqual(raw.unresolved, []);
  });

  test("UNTRACKED never deducts, even with a captured entry", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(UNTRACKED_ID, "UNTRACKED")],
      recipes: [recipeFor(UNTRACKED_ID, 3)],
    });
    const plan = await prepareInventoryDeduction(snapshotOrder({ menuItemId: UNTRACKED_ID }), {
      connection: conn,
    });
    assert.deepEqual(plan.ingredients, []);
    assert.deepEqual(plan.unresolved, []);
  });
});

// ---------- EXTRA ----------

describe("H1.3: EXTRA inventory path is unchanged", () => {
  test("a captured TRACKED requirement and an EXTRA component both deduct", async () => {
    const order = snapshotOrder();
    order.items[0].components = [
      {
        kind: "PRICED_COMPONENT",
        extraItemId: EXTRA_ID,
        quantity: 2,
        inventoryItemId: INV_B,
        stockQuantity: 1,
        stockUnit: "pcs",
      },
    ];
    const conn = makeDeductionConn({ menuItems: [menuItem(TRACKED_ID, "TRACKED")] });
    const plan = await prepareInventoryDeduction(order, { connection: conn });
    assert.deepEqual(
      plan.ingredients.sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId)),
      [
        { inventoryItemId: INV_A, quantity: 6, unit: "g" },
        { inventoryItemId: INV_B, quantity: 2, unit: "pcs" },
      ]
    );
    assert.deepEqual(plan.unresolved, []);
  });
});

// ---------- edit: snapshot capture + C1 ----------

describe("H1.3: editOrderItems captures added TRACKED lines", () => {
  test("an added TRACKED line is captured and survives a later Recipe edit", async () => {
    const { conn, writes } = makeEditConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3)],
    });
    const doc = await addLine(conn, TRACKED_ID, 2);
    assert.equal(writes.length, 1);
    const snapshot = doc.inventoryRecipeSnapshot;
    assert.ok(snapshot, "edit captured the added line");
    const entry = snapshot.recipes.find((r) => String(r.menuItemId) === TRACKED_ID);
    assert.equal(entry.ingredients[0].quantity, 3);

    // Live Recipe changed/deleted; the captured requirement still wins. The
    // legacy UNKNOWN line carried by the order keeps its own live path, so this
    // assertion is scoped to the captured TRACKED line.
    const capturedOnly = {
      ...doc,
      items: doc.items.filter((it) => String(it.itemId) === TRACKED_ID),
    };
    const freeze = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipeThrows: true,
    });
    const raw = await calculateRawRequirements(freeze, capturedOnly);
    assert.deepEqual(raw.requirements, [
      { inventoryItemId: INV_A, unit: "g", requiredQuantity: 6 },
    ]);
  });

  test("an unrelated edit leaves an existing snapshot untouched", async () => {
    const existing = {
      _id: new mongoose.Types.ObjectId(),
      status: "PENDING",
      waiterId: new mongoose.Types.ObjectId(STAFF_ID),
      items: [legacyLine(TRACKED_ID)],
      totalAmount: 5,
      inventoryRecipeSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00Z"),
        recipes: [
          {
            menuItemId: new mongoose.Types.ObjectId(TRACKED_ID),
            recipeId: null,
            ingredients: [{ inventoryItemId: new mongoose.Types.ObjectId(INV_A), quantity: 3, unit: "g" }],
          },
        ],
      },
    };
    const { conn, writes } = makeEditConn({ existing });
    await editOrderItems(
      conn,
      String(existing._id),
      [{ op: "setQty", lineId: String(existing.items[0].lineId), quantity: 2 }],
      { staffRole: "MANAGER", staffId: STAFF_ID }
    );
    assert.equal(writes.length, 1);
    assert.equal(
      writes[0].update.$set.inventoryRecipeSnapshot,
      undefined,
      "unchanged capture is not rewritten"
    );
  });
});

describe("H1.3 (C1): editOrderItems catalog outage", () => {
  test("a catalog read failure is a controlled 503 with no write", async () => {
    const { conn, writes } = makeEditConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3)],
      menuFindThrows: true,
    });
    await assert.rejects(
      () => addLine(conn, TRACKED_ID),
      (err) => {
        assert.equal(err?.name, "OrderCatalogError");
        assert.equal(err.status, 503);
        assert.equal(err.code, "CATALOG_UNAVAILABLE");
        assert.equal(/secret|server selection|timed out/i.test(err.message), false);
        return true;
      }
    );
    assert.equal(writes.length, 0, "no partial write on catalog outage");
  });

  test("a genuinely missing item stays a 404", async () => {
    const { conn, writes } = makeEditConn({ menuItems: [] });
    await assert.rejects(
      () => addLine(conn, MISSING_ID),
      (err) => {
        assert.equal(err?.name, "OrderCatalogError");
        assert.equal(err.status, 404);
        assert.equal(err.code, "CATALOG_ITEM_NOT_FOUND");
        return true;
      }
    );
    assert.equal(writes.length, 0);
  });

  test("a soft-deleted item stays a 404", async () => {
    const deleted = { ...menuItem(TRACKED_ID, "TRACKED"), isDeleted: true };
    const { conn, writes } = makeEditConn({
      menuItems: [deleted],
      recipes: [recipeFor(TRACKED_ID, 3)],
    });
    await assert.rejects(
      () => addLine(conn, TRACKED_ID),
      (err) => err?.status === 404 && err?.code === "CATALOG_ITEM_NOT_FOUND"
    );
    assert.equal(writes.length, 0);
  });

  test("a mixed valid/missing edit writes nothing", async () => {
    const { conn, writes } = makeEditConn({
      menuItems: [menuItem(UNTRACKED_ID, "UNTRACKED")],
    });
    await assert.rejects(
      () =>
        editOrderItems(
          conn,
          "507f1f77bcf86cd7994390f9",
          [
            { op: "add", menuItemId: UNTRACKED_ID, quantity: 1 },
            { op: "add", menuItemId: MISSING_ID, quantity: 1 },
          ],
          { staffRole: "MANAGER", staffId: STAFF_ID }
        ),
      (err) => err?.status === 404
    );
    assert.equal(writes.length, 0, "no partial edit is persisted");
  });
});
