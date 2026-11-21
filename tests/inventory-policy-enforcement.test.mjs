// H1.1 — policy enforcement gap closure (DB-FREE).
//
// Gap 1: editOrderItems applies the same explicit-policy gate as createOrder to
// every ADDED catalog line, without re-validating unchanged historical lines.
// Gap 2: an UNTRACKED item never produces a Recipe-based stock requirement,
// while TRACKED keeps the canonical recipe/reservation/deduction path.
//
// No MongoDB connection, no environment file, no network.

import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { addPolicyVersionSupport } from "./helpers/policy-version-fakes.mjs";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));
const { editOrderItems } = await import("../lib/orderService.js");
const {
  prepareInventoryDeduction,
  INVENTORY_POLICY_LOOKUP_FAILED_REASON,
  RECIPE_LOOKUP_FAILED_REASON,
} = await import("../lib/inventoryDeductionService.js");
const { calculateRawRequirements } = await import(
  "../lib/inventoryReservationService.js"
);

const TRACKED_ID = "507f1f77bcf86cd7994390e1";
const UNTRACKED_ID = "507f1f77bcf86cd7994390e2";
const UNKNOWN_ID = "507f1f77bcf86cd7994390e3";
const EXTERNAL_ID = "507f1f77bcf86cd7994390e4";
const BAD_TRACKED_ID = "507f1f77bcf86cd7994390e5";
const LEGACY_ID = "507f1f77bcf86cd7994390e6";
const INVENTORY_ID = "507f1f77bcf86cd7994390e7";
const EXTRA_ID = "507f1f77bcf86cd7994390e8";

const STAFF_ID = "507f1f77bcf86cd7994390f1";

// Minimal Mongoose-compatible query chain used by the model stubs.
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

function recipeFor(menuItemId, overrides = {}) {
  return {
    menuItemId,
    isActive: true,
    ingredients: [{ inventoryItemId: INVENTORY_ID, quantity: 3, unit: "g" }],
    ...overrides,
  };
}

function legacyLine() {
  return {
    lineId: new mongoose.Types.ObjectId(),
    name: "Legacy Dish",
    price: 5,
    quantity: 1,
    type: "FOOD",
    itemId: new mongoose.Types.ObjectId(LEGACY_ID),
    components: [],
    cancelled: false,
  };
}

function makeEditConn({ menuItems = [], recipes = [], extraItems = [], inventory = [] } = {}) {
  const existing = {
    _id: new mongoose.Types.ObjectId(),
    status: "PENDING",
    waiterId: new mongoose.Types.ObjectId(STAFF_ID),
    items: [legacyLine()],
    totalAmount: 5,
  };
  const writes = [];
  const Order = {
    findOne() {
      return chain(existing);
    },
    findOneAndUpdate(filter, update) {
      writes.push({ filter, update });
      return {
        ...existing,
        items: update.$set.items,
        totalAmount: update.$set.totalAmount,
      };
    },
  };
  const MenuItem = {
    find(filter) {
      const ids = (filter?._id?.$in || []).map(String);
      return chain(menuItems.filter((m) => ids.includes(String(m._id))));
    },
  };
  const Recipe = {
    find(filter) {
      const ids = (filter?.menuItemId?.$in || []).map(String);
      return chain(recipes.filter((r) => ids.includes(String(r.menuItemId))));
    },
  };
  const ExtraItem = {
    find(filter) {
      const ids = (filter?._id?.$in || []).map(String);
      return chain(extraItems.filter((e) => ids.includes(String(e._id))));
    },
    findOne() {
      return chain(null);
    },
  };
  const InventoryItem = {
    find(filter) {
      const ids = (filter?._id?.$in || []).map(String);
      return chain(inventory.filter((i) => ids.includes(String(i._id))));
    },
  };
  const InventoryReservation = {
    findOne: () => chain(null),
    create: async (docs) => docs,
    deleteOne: async () => ({ deletedCount: 0 }),
    findOneAndUpdate: async () => null,
  };
  const conn = {
    models: {
      Order,
      MenuItem,
      Recipe,
      ExtraItem,
      InventoryItem,
      InventoryReservation,
      OrderCounter: { findOneAndUpdate: async () => ({ seq: 1 }) },
    },
  };
  addPolicyVersionSupport(conn);
  return { conn, writes, existing };
}

async function addLine(conn, menuItemId, quantity = 1) {
  return editOrderItems(
    conn,
    "507f1f77bcf86cd7994390f9",
    [{ op: "add", menuItemId, quantity }],
    { staffRole: "MANAGER", staffId: STAFF_ID }
  );
}

describe("H1.1 Gap 1: editOrderItems gates every added catalog line", () => {
  test("UNKNOWN add is rejected atomically with neutral copy", async () => {
    const { conn, writes } = makeEditConn({ menuItems: [menuItem(UNKNOWN_ID)] });
    await assert.rejects(
      () => addLine(conn, UNKNOWN_ID),
      (err) => {
        assert.equal(err?.name, "OrderCatalogError");
        assert.equal(err.status, 409);
        assert.equal(err.code, "ITEM_NOT_ORDERABLE");
        assert.equal(/TRACKED|UNTRACKED|UNKNOWN|EXTERNAL/.test(err.message), false);
        return true;
      }
    );
    assert.equal(writes.length, 0, "invalid edit must not persist");
  });

  test("historical EXTERNAL add is rejected", async () => {
    const { conn, writes } = makeEditConn({
      menuItems: [menuItem(EXTERNAL_ID, "EXTERNAL")],
    });
    await assert.rejects(
      () => addLine(conn, EXTERNAL_ID),
      (err) => err?.code === "ITEM_NOT_ORDERABLE" && err.status === 409
    );
    assert.equal(writes.length, 0);
  });

  test("TRACKED without a usable Recipe is rejected", async () => {
    const { conn, writes } = makeEditConn({
      menuItems: [menuItem(BAD_TRACKED_ID, "TRACKED")],
      recipes: [],
    });
    await assert.rejects(
      () => addLine(conn, BAD_TRACKED_ID),
      (err) => err?.code === "ITEM_NOT_ORDERABLE" && err.status === 409
    );
    assert.equal(writes.length, 0);
  });

  test("TRACKED with an inactive Recipe is rejected", async () => {
    const { conn, writes } = makeEditConn({
      menuItems: [menuItem(BAD_TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(BAD_TRACKED_ID, { isActive: false })],
    });
    await assert.rejects(
      () => addLine(conn, BAD_TRACKED_ID),
      (err) => err?.code === "ITEM_NOT_ORDERABLE"
    );
    assert.equal(writes.length, 0);
  });

  test("valid TRACKED add is accepted with the canonical snapshot", async () => {
    const { conn, writes } = makeEditConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID)],
    });
    const doc = await addLine(conn, TRACKED_ID, 2);
    assert.equal(writes.length, 1);
    const added = doc.items.find((it) => String(it.itemId) === TRACKED_ID);
    assert.ok(added, "added line persisted");
    assert.equal(added.quantity, 2);
    assert.equal(added.isExternal, false);
    assert.equal(doc.totalAmount, 25); // 5 existing + 10 x 2
  });

  test("UNTRACKED add is accepted without any Recipe", async () => {
    const { conn, writes } = makeEditConn({
      menuItems: [menuItem(UNTRACKED_ID, "UNTRACKED")],
      recipes: [],
    });
    const doc = await addLine(conn, UNTRACKED_ID);
    assert.equal(writes.length, 1);
    assert.ok(doc.items.some((it) => String(it.itemId) === UNTRACKED_ID));
  });

  test("a mixed valid/invalid edit is rejected atomically", async () => {
    const { conn, writes } = makeEditConn({
      menuItems: [menuItem(UNTRACKED_ID, "UNTRACKED"), menuItem(UNKNOWN_ID)],
    });
    await assert.rejects(
      () =>
        editOrderItems(
          conn,
          "507f1f77bcf86cd7994390f9",
          [
            { op: "add", menuItemId: UNTRACKED_ID, quantity: 1 },
            { op: "add", menuItemId: UNKNOWN_ID, quantity: 1 },
          ],
          { staffRole: "MANAGER", staffId: STAFF_ID }
        ),
      (err) => err?.code === "ITEM_NOT_ORDERABLE"
    );
    assert.equal(writes.length, 0, "no partial edit is persisted");
  });

  test("unchanged legacy UNKNOWN lines are not retroactively rejected", async () => {
    const { conn, writes, existing } = makeEditConn();
    const line = existing.items[0];
    const doc = await editOrderItems(
      conn,
      existing._id,
      [{ op: "setQty", lineId: String(line.lineId), quantity: 3 }],
      { staffRole: "MANAGER", staffId: STAFF_ID }
    );
    assert.equal(writes.length, 1);
    const legacy = doc.items.find((it) => String(it.itemId) === LEGACY_ID);
    assert.equal(legacy.quantity, 3);
  });

  test("EXTRA resolution is unchanged by the policy gate", async () => {
    const extra = {
      _id: EXTRA_ID,
      name: { en: "Extra Injera" },
      category: "EXTRA",
      sellingPrice: 20,
      inventoryItemId: INVENTORY_ID,
      isAvailable: true,
    };
    const stock = {
      _id: INVENTORY_ID,
      name: "Injera",
      unit: "pcs",
      cost: 5,
      currentStock: 100,
      reservedStock: 0,
    };
    const { conn, writes, existing } = makeEditConn({
      extraItems: [extra],
      inventory: [stock],
    });
    const line = existing.items[0];
    const doc = await editOrderItems(
      conn,
      existing._id,
      [{ op: "extra", lineId: String(line.lineId), extraItemId: EXTRA_ID, quantity: 2 }],
      { staffRole: "MANAGER", staffId: STAFF_ID }
    );
    assert.equal(writes.length, 1);
    const updated = doc.items.find((it) => String(it.itemId) === LEGACY_ID);
    const component = updated.components.find((c) => c.kind === "PRICED_COMPONENT");
    assert.ok(component, "EXTRA component still resolves");
    assert.equal(String(component.extraItemId), EXTRA_ID);
    assert.equal(component.quantity, 2);
  });
});

function deductionConn({
  menuItems = [],
  recipes = [],
  menuFindThrows = false,
  recipeFindThrows = false,
} = {}) {
  return {
    models: {
      MenuItem: {
        find() {
          if (menuFindThrows) throw new Error("policy store down");
          return chain(menuItems);
        },
      },
      Recipe: {
        find() {
          if (recipeFindThrows) throw new Error("recipe store down");
          return chain(recipes);
        },
      },
    },
  };
}

function orderFor(menuItemId = TRACKED_ID) {
  return {
    _id: "507f1f77bcf86cd7994390fa",
    items: [{ itemId: menuItemId, name: "Dish", quantity: 2, type: "FOOD" }],
  };
}

describe("H1.1 Gap 2: UNTRACKED suppression in the deduction plan", () => {
  test("UNTRACKED with an attached Recipe produces no requirement", async () => {
    const conn = deductionConn({
      menuItems: [menuItem(UNTRACKED_ID, "UNTRACKED")],
      recipes: [recipeFor(UNTRACKED_ID)],
    });
    const plan = await prepareInventoryDeduction(orderFor(UNTRACKED_ID), {
      connection: conn,
    });
    assert.deepEqual(plan.ingredients, []);
    assert.deepEqual(plan.unresolved, []);
    assert.ok(plan.warnings.some((w) => w.includes("no stock requirement")));
  });

  test("UNTRACKED produces no reservation requirement through the canonical helper", async () => {
    const conn = deductionConn({
      menuItems: [menuItem(UNTRACKED_ID, "UNTRACKED")],
      recipes: [recipeFor(UNTRACKED_ID)],
    });
    const raw = await calculateRawRequirements(conn, orderFor(UNTRACKED_ID));
    assert.deepEqual(raw.requirements, []);
    assert.deepEqual(raw.unresolved, []);
  });

  test("TRACKED still reserves through the existing recipe path", async () => {
    const conn = deductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID)],
    });
    const raw = await calculateRawRequirements(conn, orderFor(TRACKED_ID));
    assert.deepEqual(raw.requirements, [
      { inventoryItemId: INVENTORY_ID, unit: "g", requiredQuantity: 6 },
    ]);
  });

  test("legacy UNKNOWN keeps legacy deduction behavior for open orders", async () => {
    const conn = deductionConn({
      menuItems: [menuItem(UNKNOWN_ID)],
      recipes: [recipeFor(UNKNOWN_ID)],
    });
    const plan = await prepareInventoryDeduction(orderFor(UNKNOWN_ID), {
      connection: conn,
    });
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INVENTORY_ID, quantity: 6, unit: "g" },
    ]);
  });

  test("UNTRACKED suppresses only the recipe; EXTRA components still deduct", async () => {
    const conn = deductionConn({
      menuItems: [menuItem(UNTRACKED_ID, "UNTRACKED")],
      recipes: [recipeFor(UNTRACKED_ID)],
    });
    const order = orderFor(UNTRACKED_ID);
    order.items[0].components = [
      {
        kind: "PRICED_COMPONENT",
        extraItemId: EXTRA_ID,
        quantity: 2,
        inventoryItemId: INVENTORY_ID,
        stockQuantity: 1,
        stockUnit: "pcs",
      },
    ];
    const plan = await prepareInventoryDeduction(order, { connection: conn });
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INVENTORY_ID, quantity: 2, unit: "pcs" },
    ]);
  });

  test("a policy read failure fails closed instead of deducting", async () => {
    const conn = deductionConn({
      menuItems: [],
      recipes: [recipeFor(TRACKED_ID)],
      menuFindThrows: true,
    });
    const plan = await prepareInventoryDeduction(orderFor(TRACKED_ID), {
      connection: conn,
    });
    assert.deepEqual(plan.ingredients, []);
    assert.ok(plan.unresolved.includes(INVENTORY_POLICY_LOOKUP_FAILED_REASON));
  });

  test("a recipe read failure keeps its existing fail-closed reason", async () => {
    const conn = deductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipeFindThrows: true,
    });
    const plan = await prepareInventoryDeduction(orderFor(TRACKED_ID), {
      connection: conn,
    });
    assert.deepEqual(plan.ingredients, []);
    assert.ok(plan.unresolved.includes(RECIPE_LOOKUP_FAILED_REASON));
  });
});
