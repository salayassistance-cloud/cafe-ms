// H1 Phase 1 — explicit inventory policy foundation (DB-FREE).
//
// Covers:
//   * TRACKED / UNTRACKED validation and legacy UNKNOWN resolution;
//   * historical EXTERNAL read compatibility and write rejection;
//   * new-order gating for UNKNOWN / EXTERNAL / invalid TRACKED;
//   * soft-deletion source contracts;
//   * EXTRA compatibility (EXTRA remains a separate waiter workflow).
//
// No MongoDB connection, no environment file, no network.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import mongoose from "mongoose";

import {
  INVENTORY_POLICY,
  INVENTORY_POLICY_HISTORICAL_EXTERNAL,
  INVENTORY_POLICY_MESSAGES,
  INVENTORY_POLICY_UNKNOWN,
  isTrackedRecipeUsable,
  resolveInventoryPolicy,
  validateExplicitInventoryPolicy,
  validateOrderLineInventoryPolicy,
} from "../lib/inventoryPolicy.js";
import { MenuItemSchema } from "../lib/models/MenuItem.js";
import { STOCK_GROUP } from "../lib/inventoryCategories.js";
import { addPolicyVersionSupport } from "./helpers/policy-version-fakes.mjs";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));
const { createOrder } = await import("../lib/orderService.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const MENU_ID = "507f1f77bcf86cd7994390c1";
const INGREDIENT_ID = "507f1f77bcf86cd7994390c2";

function catalog(overrides = {}) {
  return {
    _id: MENU_ID,
    name: { en: "Policy Test Dish" },
    price: 100,
    categoryType: "FOOD",
    station: "KITCHEN",
    targetStation: "KITCHEN",
    isAvailable: true,
    ...overrides,
  };
}

function usableRecipe(overrides = {}) {
  return {
    _id: "recipe_1",
    menuItemId: MENU_ID,
    isActive: true,
    ingredients: [{ inventoryItemId: INGREDIENT_ID, quantity: 2, unit: "g" }],
    ...overrides,
  };
}

function makeConn({ menuItems = [], recipes = [] } = {}) {
  const saved = [];
  const MenuItem = {
    find(filter) {
      const ids = (filter?._id?.$in || []).map(String);
      return {
        lean: async () =>
          menuItems.filter((m) => ids.includes(String(m._id))),
      };
    },
  };
  const Recipe = {
    find(filter) {
      const ids = (filter?.menuItemId?.$in || []).map(String);
      return {
        lean: async () =>
          recipes.filter((r) => ids.includes(String(r.menuItemId))),
      };
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
      OrderCounter: { findOneAndUpdate: async () => ({ seq: saved.length + 1 }) },
    },
  };
  addPolicyVersionSupport(conn);
  return { conn, saved };
}

function payload() {
  return {
    tableNumber: 4,
    items: [{ itemId: MENU_ID, name: "Ignored by catalog snapshot", price: 1, quantity: 1 }],
  };
}

describe("H1: explicit policy validation", () => {
  test("TRACKED and UNTRACKED are the only accepted write values", () => {
    assert.deepEqual(validateExplicitInventoryPolicy("TRACKED"), {
      ok: true,
      policy: "TRACKED",
    });
    assert.deepEqual(validateExplicitInventoryPolicy(" untracked "), {
      ok: true,
      policy: "UNTRACKED",
    });
    assert.equal(validateExplicitInventoryPolicy("UNTRACKED").policy, "UNTRACKED");
  });

  test("missing policy is rejected for new catalog writes", () => {
    for (const value of [undefined, null, "", "   "]) {
      const res = validateExplicitInventoryPolicy(value);
      assert.equal(res.ok, false);
      assert.match(res.error, /Select how this item uses stock/);
    }
  });

  test("EXTERNAL is rejected as a write value", () => {
    const res = validateExplicitInventoryPolicy("external");
    assert.equal(res.ok, false);
    assert.match(res.error, /External items are not supported/);
  });

  test("UNKNOWN and arbitrary values are rejected as write values", () => {
    assert.equal(validateExplicitInventoryPolicy("UNKNOWN").ok, false);
    assert.equal(validateExplicitInventoryPolicy("BOTH").ok, false);
    assert.equal(validateExplicitInventoryPolicy(42).ok, false);
  });

  test("MenuItem schema enum contains only TRACKED and UNTRACKED", () => {
    const path = MenuItemSchema.path("inventoryPolicy");
    assert.ok(path, "inventoryPolicy path exists");
    assert.deepEqual([...path.enumValues].sort(), ["TRACKED", "UNTRACKED"]);
    assert.equal(path.defaultValue, null);
  });

  test("MenuItem schema supports non-destructive soft deletion", () => {
    assert.equal(MenuItemSchema.path("isDeleted").defaultValue, false);
    assert.equal(MenuItemSchema.path("deletedAt").defaultValue, null);
  });

  test("a new MenuItem cannot be persisted without an explicit policy", () => {
    const Model = mongoose.connection.model(
      "H1MenuItemPolicyValidation",
      MenuItemSchema.clone()
    );
    const base = { name: { en: "Policy Test" }, price: 1, station: "KITCHEN" };
    const missing = new Model(base).validateSync();
    assert.ok(missing?.errors?.inventoryPolicy, "missing policy blocks insert");
    const explicit = new Model({
      ...base,
      inventoryPolicy: "UNTRACKED",
    }).validateSync();
    assert.equal(explicit, undefined);
  });
});

describe("H1: legacy policy resolution", () => {
  test("missing/null/empty policy resolves to UNKNOWN, never TRACKED/UNTRACKED", () => {
    assert.equal(resolveInventoryPolicy(null), INVENTORY_POLICY_UNKNOWN);
    assert.equal(resolveInventoryPolicy(undefined), INVENTORY_POLICY_UNKNOWN);
    assert.equal(resolveInventoryPolicy({}), INVENTORY_POLICY_UNKNOWN);
    assert.equal(
      resolveInventoryPolicy({ inventoryPolicy: null }),
      INVENTORY_POLICY_UNKNOWN
    );
    assert.equal(
      resolveInventoryPolicy({ inventoryPolicy: "" }),
      INVENTORY_POLICY_UNKNOWN
    );
  });

  test("stored TRACKED/UNTRACKED values are preserved", () => {
    assert.equal(
      resolveInventoryPolicy({ inventoryPolicy: "TRACKED" }),
      INVENTORY_POLICY.TRACKED
    );
    assert.equal(
      resolveInventoryPolicy({ inventoryPolicy: "UNTRACKED" }),
      INVENTORY_POLICY.UNTRACKED
    );
  });

  test("historical EXTERNAL stays readable but distinct from valid policies", () => {
    assert.equal(
      resolveInventoryPolicy({ inventoryPolicy: "EXTERNAL" }),
      INVENTORY_POLICY_HISTORICAL_EXTERNAL
    );
    assert.equal(
      resolveInventoryPolicy({ inventoryPolicy: "EXTERNAL" }),
      "EXTERNAL"
    );
  });

  test("arbitrary legacy strings are treated as UNKNOWN", () => {
    assert.equal(
      resolveInventoryPolicy({ inventoryPolicy: "MAYBE" }),
      INVENTORY_POLICY_UNKNOWN
    );
  });
});

describe("H1: TRACKED recipe usability", () => {
  test("active, non-empty, structurally valid recipe is usable", () => {
    assert.equal(isTrackedRecipeUsable(usableRecipe()), true);
    // Legacy recipe without isActive is active (explicit false is the only off).
    assert.equal(isTrackedRecipeUsable(usableRecipe({ isActive: undefined })), true);
  });

  test("missing, inactive, or empty recipe is not usable", () => {
    assert.equal(isTrackedRecipeUsable(null), false);
    assert.equal(isTrackedRecipeUsable(usableRecipe({ isActive: false })), false);
    assert.equal(isTrackedRecipeUsable(usableRecipe({ ingredients: [] })), false);
    assert.equal(isTrackedRecipeUsable(usableRecipe({ ingredients: undefined })), false);
  });

  test("malformed ingredient rows fail closed", () => {
    const bad = (row) => usableRecipe({ ingredients: [row] });
    assert.equal(isTrackedRecipeUsable(bad({ inventoryItemId: "", quantity: 1, unit: "g" })), false);
    assert.equal(isTrackedRecipeUsable(bad({ inventoryItemId: "not-an-id", quantity: 1, unit: "g" })), false);
    assert.equal(isTrackedRecipeUsable(bad({ inventoryItemId: INGREDIENT_ID, quantity: 0, unit: "g" })), false);
    assert.equal(isTrackedRecipeUsable(bad({ inventoryItemId: INGREDIENT_ID, quantity: 1, unit: "" })), false);
    assert.equal(isTrackedRecipeUsable(bad({ inventoryItemId: INGREDIENT_ID, quantity: NaN, unit: "g" })), false);
  });
});

describe("H1: new-order policy gate", () => {
  test("UNKNOWN is blocked with neutral, actionable copy", () => {
    const res = validateOrderLineInventoryPolicy({ inventoryPolicy: null });
    assert.equal(res.ok, false);
    assert.equal(res.code, "ITEM_NOT_ORDERABLE");
    assert.equal(res.reason, "POLICY_UNKNOWN");
    assert.equal(res.error, INVENTORY_POLICY_MESSAGES.UNKNOWN);
    assert.equal(/TRACKED|UNTRACKED|UNKNOWN|EXTERNAL/.test(res.error), false);
  });

  test("historical EXTERNAL is never orderable", () => {
    const res = validateOrderLineInventoryPolicy({ inventoryPolicy: "EXTERNAL" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "POLICY_HISTORICAL_EXTERNAL");
    assert.equal(/TRACKED|UNTRACKED|UNKNOWN|EXTERNAL/.test(res.error), false);
  });

  test("UNTRACKED needs no recipe and is orderable", () => {
    assert.deepEqual(
      validateOrderLineInventoryPolicy({ inventoryPolicy: "UNTRACKED" }),
      { ok: true, policy: "UNTRACKED" }
    );
  });

  test("TRACKED requires a usable recipe", () => {
    assert.equal(
      validateOrderLineInventoryPolicy({
        inventoryPolicy: "TRACKED",
        recipe: usableRecipe(),
      }).ok,
      true
    );
    const blocked = validateOrderLineInventoryPolicy({
      inventoryPolicy: "TRACKED",
      recipe: null,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "TRACKED_RECIPE_INVALID");
    assert.equal(/TRACKED|UNTRACKED|UNKNOWN|EXTERNAL/.test(blocked.error), false);
  });
});

describe("H1: createOrder enforces the policy for new orders", () => {
  test("UNKNOWN catalog item rejects the whole order before any write", async () => {
    const { conn, saved } = makeConn({ menuItems: [catalog()] });
    await assert.rejects(
      () => createOrder(conn, payload()),
      (err) =>
        err?.name === "OrderCatalogError" &&
        err.status === 409 &&
        err.code === "ITEM_NOT_ORDERABLE" &&
        /not available for new orders/.test(err.message)
    );
    assert.equal(saved.length, 0);
  });

  test("historical EXTERNAL catalog item rejects the whole order", async () => {
    const { conn, saved } = makeConn({
      menuItems: [catalog({ inventoryPolicy: "EXTERNAL" })],
    });
    await assert.rejects(
      () => createOrder(conn, payload()),
      (err) => err?.code === "ITEM_NOT_ORDERABLE"
    );
    assert.equal(saved.length, 0);
  });

  test("TRACKED without a usable recipe rejects the whole order", async () => {
    const { conn, saved } = makeConn({
      menuItems: [catalog({ inventoryPolicy: "TRACKED" })],
      recipes: [],
    });
    await assert.rejects(
      () => createOrder(conn, payload()),
      (err) => err?.code === "ITEM_NOT_ORDERABLE"
    );
    assert.equal(saved.length, 0);
  });

  test("TRACKED with an inactive recipe rejects the whole order", async () => {
    const { conn, saved } = makeConn({
      menuItems: [catalog({ inventoryPolicy: "TRACKED" })],
      recipes: [usableRecipe({ isActive: false })],
    });
    await assert.rejects(
      () => createOrder(conn, payload()),
      (err) => err?.code === "ITEM_NOT_ORDERABLE"
    );
    assert.equal(saved.length, 0);
  });

  test("TRACKED with duplicate recipes fails closed", async () => {
    const { conn, saved } = makeConn({
      menuItems: [catalog({ inventoryPolicy: "TRACKED" })],
      recipes: [usableRecipe(), usableRecipe({ _id: "recipe_2" })],
    });
    await assert.rejects(
      () => createOrder(conn, payload()),
      (err) => err?.code === "ITEM_NOT_ORDERABLE"
    );
    assert.equal(saved.length, 0);
  });

  test("TRACKED with a usable recipe is accepted", async () => {
    const { conn, saved } = makeConn({
      menuItems: [catalog({ inventoryPolicy: "TRACKED" })],
      recipes: [usableRecipe()],
    });
    const doc = await createOrder(conn, payload());
    assert.equal(saved.length, 1);
    assert.equal(String(doc.items[0].itemId), MENU_ID);
  });

  test("UNTRACKED is accepted without any recipe", async () => {
    const { conn, saved } = makeConn({
      menuItems: [catalog({ inventoryPolicy: "UNTRACKED" })],
      recipes: [],
    });
    const doc = await createOrder(conn, payload());
    assert.equal(saved.length, 1);
    assert.equal(String(doc.items[0].itemId), MENU_ID);
  });
});

describe("H1: source contracts", () => {
  test("new MenuItem writes require an explicit policy", () => {
    const actions = src("app/manager/menu-crud/actions.js");
    assert.ok(actions.includes("validateExplicitInventoryPolicy"));
    assert.ok(actions.includes("inventoryPolicy: inventoryPolicyCheck.policy"));
  });

  test("updates cannot silently classify a legacy item", () => {
    const actions = src("app/manager/menu-crud/actions.js");
    assert.ok(
      actions.includes(
        "Inventory tracking can only be changed through the inventory review workflow."
      )
    );
  });

  test("MenuItem deletion is soft and never hard-deletes catalog rows", () => {
    const actions = src("app/manager/menu-crud/actions.js");
    assert.equal(actions.includes("MenuItem.deleteOne("), false);
    assert.equal(actions.includes("MenuItem.deleteMany("), false);
    assert.ok(actions.includes("isDeleted: true"));
    assert.ok(actions.includes("deletedAt: new Date()"));
  });

  test("active menu reads exclude soft-deleted rows", () => {
    assert.ok(
      src("lib/menuService.js").includes("MenuItem.find({ isDeleted: { $ne: true } })")
    );
    const orders = src("lib/orderService.js");
    assert.ok(orders.includes("isDeleted: { $ne: true }"));
  });

  test("historical isExternal remains read-only and new orders still write false", () => {
    const orderModel = src("lib/models/Order.js");
    const orders = src("lib/orderService.js");
    assert.ok(orderModel.includes("isExternal: { type: Boolean, default: false }"));
    assert.ok(orders.includes("isExternal: false"));
    assert.equal(orders.includes("isExternal: !!it.isExternal"), false);
  });

  test("no active EXTERNAL inventory policy branch exists", () => {
    const policy = src("lib/inventoryPolicy.js");
    const menu = src("lib/models/MenuItem.js");
    assert.equal(policy.includes("INVENTORY_POLICY.EXTERNAL"), false);
    assert.equal(menu.includes('enum: ["TRACKED", "UNTRACKED", "EXTERNAL"]'), false);
    const actions = src("app/manager/menu-crud/actions.js");
    assert.equal(actions.includes('"EXTERNAL"'), false);
  });
});

describe("H1: EXTRA compatibility", () => {
  test("EXTRA remains the only supported waiter-added extra workflow", () => {
    assert.equal(STOCK_GROUP.EXTRA, "EXTRA");
    const orders = src("lib/orderService.js");
    assert.ok(orders.includes("resolveExtraComponents"));
    const policy = src("lib/inventoryPolicy.js");
    assert.equal(policy.toLowerCase().includes("extraitem"), false);
  });

  test("extra item service still resolves from the canonical InventoryItem catalog", () => {
    const extra = src("lib/extraItemService.js");
    assert.ok(extra.includes("InventoryItem"));
    assert.ok(extra.includes("extraItemId"));
  });
});
