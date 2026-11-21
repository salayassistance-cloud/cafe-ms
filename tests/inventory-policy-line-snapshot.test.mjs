// H1.4 — immutable per-line inventory policy snapshot.
//
// DB-FREE ONLY. No MongoDB connection, no environment file, no network. The
// create/edit capture paths and the deduction path run against in-memory model
// stubs so the per-line TRACKED/UNTRACKED freeze, its precedence over the live
// MenuItem policy, the fail-closed malformed cases and the legacy fallback are
// exercised for real instead of only matching source text.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { addPolicyVersionSupport } from "./helpers/policy-version-fakes.mjs";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const { createOrder, editOrderItems } = await import("../lib/orderService.js");
const {
  prepareInventoryDeduction,
  readLineInventoryPolicySnapshot,
  INVENTORY_POLICY_SNAPSHOT_INVALID_REASON,
  TRACKED_RECIPE_SNAPSHOT_MISSING_REASON,
  RECIPE_LOOKUP_FAILED_REASON,
} = await import("../lib/inventoryDeductionService.js");
const {
  calculateRawRequirements,
  reconcileOrderInventory,
} = await import("../lib/inventoryReservationService.js");
const { buildRequirementFingerprint } = await import("../lib/inventoryReservationRules.js");

const TRACKED_ID = "507f1f77bcf86cd7994390b1";
const UNTRACKED_ID = "507f1f77bcf86cd7994390b2";
const UNKNOWN_ID = "507f1f77bcf86cd7994390b3";
const INV_A = "507f1f77bcf86cd7994390b4";
const STAFF_ID = "507f1f77bcf86cd7994390b5";
const ORDER_ID = "507f1f77bcf86cd7994390b6";

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

function recipeFor(menuItemId, quantity = 3) {
  return {
    _id: new mongoose.Types.ObjectId(),
    menuItemId,
    isActive: true,
    ingredients: [{ inventoryItemId: INV_A, quantity, unit: "g" }],
  };
}

function orderPayload(itemId, quantity = 2, extra = {}) {
  return {
    tableNumber: 7,
    items: [
      {
        itemId,
        name: "client name",
        price: 1,
        quantity,
        type: "FOOD",
        ...extra,
      },
    ],
  };
}

// ---------- createOrder stubs ----------

function makeCreateConn({ menuItems = [], recipes = [] } = {}) {
  const saved = [];
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
  const InventoryItem = {
    find: () =>
      chain([
        { _id: INV_A, name: "Flour", unit: "g", currentStock: 1000, reservedStock: 0, cost: 1 },
      ]),
    updateOne: async () => ({ modifiedCount: 1 }),
  };
  const InventoryReservation = {
    findOne: () => chain(null),
    findOneAndUpdate: (filter, update) => ({
      lean: async () => update?.$setOnInsert || update,
    }),
    create: async (docs) => docs,
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
  return { conn, saved };
}

// ---------- editOrderItems stubs ----------

function makeEditConn({ menuItems = [], recipes = [], existing = null } = {}) {
  const base = existing || {
    _id: new mongoose.Types.ObjectId(),
    status: "PENDING",
    waiterId: new mongoose.Types.ObjectId(STAFF_ID),
    items: [],
    totalAmount: 0,
    inventoryRecipeSnapshot: null,
  };
  const writes = [];
  const Order = {
    findOne: () => chain(base),
    findOneAndUpdate(filter, update) {
      writes.push({ filter, update });
      return { ...base, ...(update?.$set || {}) };
    },
  };
  const MenuItem = {
    find(filter) {
      const ids = (filter?._id?.$in || []).map(String);
      return chain(
        menuItems.filter((m) => ids.includes(String(m._id)) && m.isDeleted !== true)
      );
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
    updateOne: async () => ({ modifiedCount: 1 }),
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
  return { conn, writes };
}

// ---------- deduction stubs ----------

function makeDeductionConn({ menuItems = [], recipes = [], recipeThrows = false } = {}) {
  const recipeReads = [];
  return {
    recipeReads,
    models: {
      MenuItem: { find: () => chain(menuItems) },
      Recipe: {
        find(filter) {
          recipeReads.push(filter);
          if (recipeThrows) throw new Error("live recipe read must not happen");
          return chain(recipes);
        },
      },
      InventoryItem: {
        find: () =>
          chain([
            { _id: INV_A, name: "Flour", unit: "g", currentStock: 1000, reservedStock: 0, cost: 1 },
          ]),
        updateOne: async () => ({ modifiedCount: 1 }),
      },
      InventoryReservation: {
        findOne: () => chain(null),
        findOneAndUpdate: (filter, update) => ({
          lean: async () => update?.$setOnInsert || update,
        }),
        create: async (docs) => docs,
      },
    },
  };
}

function lineWithPolicy(itemId, policy, quantity = 2) {
  const line = {
    lineId: new mongoose.Types.ObjectId(),
    itemId,
    name: "Dish",
    price: 5,
    quantity,
    type: "FOOD",
    components: [],
    cancelled: false,
  };
  if (policy !== undefined) line.inventoryPolicySnapshot = policy;
  return line;
}

function orderWithLines(lines, recipes = null) {
  const order = { _id: ORDER_ID, items: lines };
  if (recipes) {
    order.inventoryRecipeSnapshot = {
      capturedAt: new Date("2026-01-01T00:00:00Z"),
      recipes,
    };
  }
  return order;
}

// ==========================================================================
// 1-3. Capture at order creation
// ==========================================================================

describe("H1.4: createOrder freezes the resolved policy on every new line", () => {
  test("a new TRACKED line captures TRACKED", async () => {
    const { conn, saved } = makeCreateConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3)],
    });
    await createOrder(conn, orderPayload(TRACKED_ID, 2));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].items[0].inventoryPolicySnapshot, "TRACKED");
    assert.equal(String(saved[0].items[0].type), "FOOD");
  });

  test("a new UNTRACKED line captures UNTRACKED without any Recipe", async () => {
    const { conn, saved } = makeCreateConn({
      menuItems: [menuItem(UNTRACKED_ID, "UNTRACKED")],
      recipes: [],
    });
    await createOrder(conn, orderPayload(UNTRACKED_ID, 1));
    assert.equal(saved[0].items[0].inventoryPolicySnapshot, "UNTRACKED");
    assert.equal(saved[0].inventoryRecipeSnapshot, null);
  });

  test("a mixed order keeps a distinct policy per line", async () => {
    const { conn, saved } = makeCreateConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED"), menuItem(UNTRACKED_ID, "UNTRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3)],
    });
    const payload = {
      tableNumber: 7,
      items: [
        { itemId: TRACKED_ID, name: "c1", price: 1, quantity: 2, type: "FOOD" },
        { itemId: UNTRACKED_ID, name: "c2", price: 1, quantity: 1, type: "FOOD" },
      ],
    };
    await createOrder(conn, payload);
    const byItem = new Map(
      saved[0].items.map((it) => [String(it.itemId), it.inventoryPolicySnapshot])
    );
    assert.equal(byItem.get(TRACKED_ID), "TRACKED");
    assert.equal(byItem.get(UNTRACKED_ID), "UNTRACKED");
  });

  test("a client-supplied policy value is ignored", async () => {
    const { conn, saved } = makeCreateConn({
      menuItems: [menuItem(UNTRACKED_ID, "UNTRACKED")],
      recipes: [],
    });
    // The waiter payload claims TRACKED; the catalog says UNTRACKED.
    await createOrder(
      conn,
      orderPayload(UNTRACKED_ID, 1, {
        inventoryPolicySnapshot: "TRACKED",
        inventoryPolicy: "TRACKED",
      })
    );
    assert.equal(saved[0].items[0].inventoryPolicySnapshot, "UNTRACKED");
  });
});

// ==========================================================================
// 4-5. Capture at edit time
// ==========================================================================

describe("H1.4: editOrderItems captures only newly added lines", () => {
  test("existing line snapshots survive an unrelated edit, added lines capture their policy", async () => {
    const existingLineTracked = lineWithPolicy(TRACKED_ID, "TRACKED", 1);
    const existingLineUntracked = lineWithPolicy(UNTRACKED_ID, "UNTRACKED", 1);
    const existing = {
      _id: new mongoose.Types.ObjectId(),
      status: "PENDING",
      waiterId: new mongoose.Types.ObjectId(STAFF_ID),
      items: [existingLineTracked, existingLineUntracked],
      totalAmount: 10,
      inventoryRecipeSnapshot: null,
    };
    const { conn, writes } = makeEditConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED"), menuItem(UNTRACKED_ID, "UNTRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3)],
      existing,
    });

    await editOrderItems(
      conn,
      ORDER_ID,
      [{ op: "add", menuItemId: UNTRACKED_ID, quantity: 2 }],
      { staffRole: "MANAGER", staffId: STAFF_ID }
    );

    assert.equal(writes.length, 1);
    const persisted = writes[0].update.$set.items;
    assert.equal(persisted.length, 3);
    // Byte-for-byte preservation of the two pre-existing lines.
    assert.equal(persisted[0].inventoryPolicySnapshot, "TRACKED");
    assert.equal(persisted[1].inventoryPolicySnapshot, "UNTRACKED");
    assert.equal(String(persisted[0].lineId), String(existingLineTracked.lineId));
    assert.equal(String(persisted[1].lineId), String(existingLineUntracked.lineId));
    // The added line carries the current catalog policy.
    assert.equal(persisted[2].inventoryPolicySnapshot, "UNTRACKED");
    assert.equal(String(persisted[2].itemId), UNTRACKED_ID);
  });

  test("an added TRACKED line captures TRACKED and its Recipe", async () => {
    const { conn, writes } = makeEditConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 4)],
      existing: {
        _id: new mongoose.Types.ObjectId(),
        status: "PENDING",
        waiterId: new mongoose.Types.ObjectId(STAFF_ID),
        items: [lineWithPolicy(UNTRACKED_ID, "UNTRACKED", 1)],
        totalAmount: 5,
        inventoryRecipeSnapshot: null,
      },
    });

    await editOrderItems(
      conn,
      ORDER_ID,
      [{ op: "add", menuItemId: TRACKED_ID, quantity: 1 }],
      { staffRole: "MANAGER", staffId: STAFF_ID }
    );

    const added = writes[0].update.$set.items[1];
    assert.equal(added.inventoryPolicySnapshot, "TRACKED");
    assert.equal(writes[0].update.$set.items[0].inventoryPolicySnapshot, "UNTRACKED");
    const capture = writes[0].update.$set.inventoryRecipeSnapshot;
    assert.ok(capture);
    assert.equal(capture.recipes.length, 1);
    assert.equal(String(capture.recipes[0].menuItemId), TRACKED_ID);
    assert.equal(capture.recipes[0].ingredients[0].quantity, 4);
  });

  test("an unchanged quantity edit leaves every snapshot untouched", async () => {
    const existing = {
      _id: new mongoose.Types.ObjectId(),
      status: "PENDING",
      waiterId: new mongoose.Types.ObjectId(STAFF_ID),
      items: [lineWithPolicy(TRACKED_ID, "TRACKED", 1)],
      totalAmount: 5,
      inventoryRecipeSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00Z"),
        recipes: [
          {
            menuItemId: TRACKED_ID,
            recipeId: null,
            ingredients: [{ inventoryItemId: INV_A, quantity: 3, unit: "g" }],
          },
        ],
      },
    };
    const { conn, writes } = makeEditConn({ existing });
    const lineId = String(existing.items[0].lineId);

    await editOrderItems(
      conn,
      ORDER_ID,
      [{ op: "setqty", lineId, quantity: 3 }],
      { staffRole: "MANAGER", staffId: STAFF_ID }
    );

    assert.equal(writes[0].update.$set.items[0].inventoryPolicySnapshot, "TRACKED");
    assert.equal(writes[0].update.$set.items[0].quantity, 3);
    // No new capture is written for an untouched line set.
    assert.equal("inventoryRecipeSnapshot" in writes[0].update.$set, false);
  });
});

// ==========================================================================
// 6-8. Deduction precedence
// ==========================================================================

describe("H1.4: deduction uses the per-line snapshot, not the live catalog", () => {
  test("an UNTRACKED snapshot never deducts even when the live item is TRACKED with a Recipe", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(UNTRACKED_ID, "TRACKED")],
      recipes: [recipeFor(UNTRACKED_ID, 3)],
    });
    const plan = await prepareInventoryDeduction(
      orderWithLines([lineWithPolicy(UNTRACKED_ID, "UNTRACKED", 2)]),
      { connection: conn }
    );
    assert.deepEqual(plan.ingredients, []);
    assert.deepEqual(plan.unresolved, []);
    // No catalog or Recipe read is needed for an untracked capture.
    assert.deepEqual(conn.recipeReads, []);
  });

  test("a TRACKED snapshot keeps the captured Recipe when the live item becomes UNTRACKED", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "UNTRACKED")],
      recipes: [],
      recipeThrows: true,
    });
    const order = orderWithLines([lineWithPolicy(TRACKED_ID, "TRACKED", 2)], [
      {
        menuItemId: TRACKED_ID,
        recipeId: null,
        ingredients: [{ inventoryItemId: INV_A, quantity: 3, unit: "g" }],
      },
    ]);
    const plan = await prepareInventoryDeduction(order, { connection: conn });
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INV_A, quantity: 6, unit: "g" },
    ]);
    assert.deepEqual(plan.unresolved, []);
    assert.deepEqual(conn.recipeReads, [], "the live Recipe is never read");
  });

  test("a TRACKED snapshot ignores a later live Recipe change", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      // Live Recipe would produce 10g per unit; the capture must win with 3g.
      recipes: [recipeFor(TRACKED_ID, 10)],
    });
    const order = orderWithLines([lineWithPolicy(TRACKED_ID, "TRACKED", 1)], [
      {
        menuItemId: TRACKED_ID,
        recipeId: null,
        ingredients: [{ inventoryItemId: INV_A, quantity: 3, unit: "g" }],
      },
    ]);
    const plan = await prepareInventoryDeduction(order, { connection: conn });
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INV_A, quantity: 3, unit: "g" },
    ]);
    assert.deepEqual(conn.recipeReads, []);
  });

  test("a malformed policy snapshot fails closed", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3)],
    });
    const plan = await prepareInventoryDeduction(
      orderWithLines([lineWithPolicy(TRACKED_ID, "MAYBE", 2)]),
      { connection: conn }
    );
    assert.deepEqual(plan.ingredients, []);
    assert.ok(
      plan.unresolved.some((r) => r.includes(INVENTORY_POLICY_SNAPSHOT_INVALID_REASON)),
      "malformed capture must be unresolved, never a live-policy fallback"
    );
  });

  test("a TRACKED snapshot without a captured Recipe fails closed instead of using the live Recipe", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3)],
    });
    const plan = await prepareInventoryDeduction(
      orderWithLines([lineWithPolicy(TRACKED_ID, "TRACKED", 2)]),
      { connection: conn }
    );
    assert.deepEqual(plan.ingredients, []);
    assert.ok(
      plan.unresolved.some((r) => r.includes(TRACKED_RECIPE_SNAPSHOT_MISSING_REASON))
    );
  });

  test("a mixed order still processes each line under its own snapshot", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "UNTRACKED")],
      recipes: [],
      recipeThrows: true,
    });
    const order = orderWithLines(
      [
        lineWithPolicy(TRACKED_ID, "TRACKED", 2),
        lineWithPolicy(UNTRACKED_ID, "UNTRACKED", 5),
      ],
      [
        {
          menuItemId: TRACKED_ID,
          recipeId: null,
          ingredients: [{ inventoryItemId: INV_A, quantity: 2, unit: "g" }],
        },
      ]
    );
    const plan = await prepareInventoryDeduction(order, { connection: conn });
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INV_A, quantity: 4, unit: "g" },
    ]);
    assert.deepEqual(plan.unresolved, []);
  });
});

// ==========================================================================
// 9. Legacy compatibility
// ==========================================================================

describe("H1.4: legacy lines keep the existing compatibility path", () => {
  test("a line with no snapshot uses the live policy and live Recipe", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(TRACKED_ID, "TRACKED")],
      recipes: [recipeFor(TRACKED_ID, 3)],
    });
    const plan = await prepareInventoryDeduction(
      orderWithLines([lineWithPolicy(TRACKED_ID, undefined, 2)]),
      { connection: conn }
    );
    assert.deepEqual(plan.ingredients, [
      { inventoryItemId: INV_A, quantity: 6, unit: "g" },
    ]);
    assert.deepEqual(plan.unresolved, []);
  });

  test("an UNKNOWN legacy line with no Recipe stays non-blocking", async () => {
    const conn = makeDeductionConn({
      menuItems: [menuItem(UNKNOWN_ID, undefined)],
      recipes: [],
    });
    const plan = await prepareInventoryDeduction(
      orderWithLines([lineWithPolicy(UNKNOWN_ID, undefined, 1)]),
      { connection: conn }
    );
    assert.deepEqual(plan.ingredients, []);
    assert.deepEqual(plan.unresolved, []);
  });

  test("a legacy line still fails closed when the policy read fails", async () => {
    const conn = {
      models: {
        MenuItem: {
          find() {
            throw new Error("policy read failed");
          },
        },
        Recipe: { find: () => chain([]) },
        InventoryItem: { find: () => chain([]) },
      },
    };
    const plan = await prepareInventoryDeduction(
      orderWithLines([lineWithPolicy(TRACKED_ID, undefined, 1)]),
      { connection: conn }
    );
    assert.deepEqual(plan.ingredients, []);
    assert.ok(plan.unresolved.length > 0);
  });

  test("readLineInventoryPolicySnapshot distinguishes legacy, valid and malformed", () => {
    assert.equal(readLineInventoryPolicySnapshot({}), null);
    assert.equal(readLineInventoryPolicySnapshot({ inventoryPolicySnapshot: null }), null);
    assert.equal(readLineInventoryPolicySnapshot({ inventoryPolicySnapshot: "TRACKED" }), "TRACKED");
    assert.equal(
      readLineInventoryPolicySnapshot({ inventoryPolicySnapshot: " untracked " }),
      "UNTRACKED"
    );
    assert.equal(readLineInventoryPolicySnapshot({ inventoryPolicySnapshot: "EXTERNAL" }), "INVALID");
    assert.equal(readLineInventoryPolicySnapshot({ inventoryPolicySnapshot: "" }), "INVALID");
  });
});

// ==========================================================================
// 10. Approval fingerprint invalidation
// ==========================================================================

describe("H1.4: a changed requirement still invalidates a legacy approval", () => {
  test("reconcile clears approval when the fingerprint changes under a policy snapshot", async () => {
    const writes = [];
    const staleReservation = {
      _id: "507f1f77bcf86cd7994390c1",
      orderId: ORDER_ID,
      status: "APPROVED",
      approval: { approvedAt: new Date("2026-01-01T00:00:00Z") },
      requirementFingerprint: "stale-approval-fingerprint",
      items: [],
    };
    const session = {
      startTransaction() {},
      async commitTransaction() {},
      async abortTransaction() {},
      async endSession() {},
    };
    const Reservation = {
      findOne() {
        const q = { session: () => q, lean: async () => staleReservation };
        return q;
      },
      findOneAndUpdate(filter, update) {
        writes.push({ filter, update });
        return { lean: async () => ({ ...staleReservation, ...(update.$set || {}) }) };
      },
    };
    const conn = {
      models: {
        InventoryReservation: Reservation,
        MenuItem: { find: () => chain([menuItem(TRACKED_ID, "UNTRACKED")]) },
        Recipe: { find: () => chain([]) },
        InventoryItem: {
          find: () =>
            chain([
              {
                _id: INV_A,
                name: "Flour",
                unit: "g",
                currentStock: 1000,
                reservedStock: 0,
                cost: 1,
              },
            ]),
          updateOne: async () => ({ modifiedCount: 1 }),
        },
      },
      startSession: async () => session,
    };

    const order = orderWithLines([lineWithPolicy(TRACKED_ID, "TRACKED", 2)], [
      {
        menuItemId: TRACKED_ID,
        recipeId: null,
        ingredients: [{ inventoryItemId: INV_A, quantity: 3, unit: "g" }],
      },
    ]);

    const result = await reconcileOrderInventory(conn, order);

    assert.equal(writes.length, 1);
    const set = writes[0].update.$set;
    assert.equal(set.approval, null, "the stale approval must be cleared");
    assert.equal(set.status, "RESERVED");
    assert.equal(result.approval, null);

    // The recomputed fingerprint is the one the gate compares against.
    const raw = await calculateRawRequirements(conn, order);
    const expected = buildRequirementFingerprint(ORDER_ID, raw.requirements);
    assert.equal(set.requirementFingerprint, expected);
    assert.notEqual(set.requirementFingerprint, "stale-approval-fingerprint");
  });

  test("an UNTRACKED capture produces no requirement, so the fingerprint is empty", async () => {
    const conn = makeDeductionConn({ menuItems: [menuItem(UNTRACKED_ID, "TRACKED")] });
    const order = orderWithLines([lineWithPolicy(UNTRACKED_ID, "UNTRACKED", 3)]);
    const raw = await calculateRawRequirements(conn, order);
    assert.deepEqual(raw.requirements, []);
    assert.deepEqual(raw.unresolved, []);
    assert.equal(
      buildRequirementFingerprint(ORDER_ID, raw.requirements),
      buildRequirementFingerprint(ORDER_ID, [])
    );
  });
});
