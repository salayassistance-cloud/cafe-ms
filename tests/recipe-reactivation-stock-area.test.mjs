// M-1 regression — DB-free.
//
// Reactivating an inactive Recipe must re-run the full stock-area compatibility
// check against the effective stored tuple. Deactivation stays unchecked so an
// incompatible legacy recipe can always be switched off. The decision is a pure
// production helper used by lib/recipeWriteService.js (OBS-3 extraction).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateRecipeStockArea,
  requiresStockAreaRevalidation,
  recipeIngredientTupleKey,
  validateRecipeIngredientUnits,
  isRecipeReactivation,
  RECIPE_STOCK_AREA_MISMATCH,
  RECIPE_UNIT_MISMATCH,
  RECIPE_UNIT_ITEM_NOT_FOUND,
} from "../lib/recipeStockArea.js";
import { STOCK_GROUP } from "../lib/inventoryCategories.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const KITCHEN_ITEM = { _id: "inv_k", name: "Rice", stockGroup: STOCK_GROUP.KITCHEN };
const BARISTA_ITEM = { _id: "inv_b", name: "Milk", stockGroup: STOCK_GROUP.BARISTA };
const EXTRA_ITEM = { _id: "inv_e", name: "Extra Injera", stockGroup: STOCK_GROUP.EXTRA };
const UNCLASSIFIED_ITEM = { _id: "inv_u", name: "Legacy Item", stockGroup: null };

const inventoryById = new Map(
  [KITCHEN_ITEM, BARISTA_ITEM, EXTRA_ITEM, UNCLASSIFIED_ITEM].map((item) => [
    String(item._id),
    item,
  ])
);

const foodMenu = { _id: "menu_1", name: { en: "Test" }, categoryType: "FOOD" };

function check(item) {
  return validateRecipeStockArea({
    menuItem: foodMenu,
    ingredients: [{ inventoryItemId: String(item._id), quantity: 1, unit: "g" }],
    inventoryById,
  });
}

function storedRecipe(item, overrides = {}) {
  return {
    _id: "recipe_1",
    menuItemId: "menu_1",
    isActive: false,
    ingredients: [{ inventoryItemId: String(item._id), quantity: 1, unit: "g" }],
    ...overrides,
  };
}

describe("M-1: reactivation runs the full stock-area check", () => {
  test("a compatible inactive recipe is validated and passes", () => {
    const current = storedRecipe(KITCHEN_ITEM);
    const next = { isActive: true };
    assert.equal(requiresStockAreaRevalidation(current, next), true);
    assert.equal(check(KITCHEN_ITEM).ok, true);
  });

  test("cross-area reactivation is detected and rejected", () => {
    const current = storedRecipe(BARISTA_ITEM);
    assert.equal(requiresStockAreaRevalidation(current, { isActive: true }), true);
    const result = check(BARISTA_ITEM);
    assert.equal(result.ok, false);
    assert.equal(result.code, RECIPE_STOCK_AREA_MISMATCH);
  });

  test("EXTRA and unclassified stock reactivation is rejected", () => {
    for (const item of [EXTRA_ITEM, UNCLASSIFIED_ITEM]) {
      assert.equal(requiresStockAreaRevalidation(storedRecipe(item), { isActive: true }), true);
      const result = check(item);
      assert.equal(result.ok, false);
      assert.equal(result.code, RECIPE_STOCK_AREA_MISMATCH);
    }
  });

  test("deactivation of an incompatible legacy recipe stays possible", () => {
    const current = storedRecipe(BARISTA_ITEM, { isActive: true });
    assert.equal(requiresStockAreaRevalidation(current, { isActive: false }), false);
  });

  test("an unchanged active recipe resend is not revalidated", () => {
    const current = storedRecipe(KITCHEN_ITEM, { isActive: true });
    assert.equal(requiresStockAreaRevalidation(current, { isActive: true }), false);
  });

  test("legacy missing isActive is treated as active, not as reactivation", () => {
    const current = storedRecipe(KITCHEN_ITEM);
    delete current.isActive;
    assert.equal(requiresStockAreaRevalidation(current, { isActive: true }), false);
  });

  test("menu or ingredient changes still require validation", () => {
    const current = storedRecipe(KITCHEN_ITEM, { isActive: true });
    assert.equal(requiresStockAreaRevalidation(current, { menuItemId: "menu_2" }), true);
    assert.equal(
      requiresStockAreaRevalidation(current, {
        ingredients: [{ inventoryItemId: "inv_b", quantity: 1, unit: "g" }],
      }),
      true
    );
    assert.equal(
      requiresStockAreaRevalidation(current, {
        ingredients: [{ inventoryItemId: "inv_k", quantity: 2, unit: "g" }],
      }),
      true
    );
  });

  test("the ingredient tuple ignores ordering but not quantity or unit", () => {
    const a = [{ inventoryItemId: "inv_k", quantity: 1, unit: "G" }];
    const b = [{ inventoryItemId: "inv_b", quantity: 2, unit: "g" }];
    assert.equal(recipeIngredientTupleKey([...a, ...b]), recipeIngredientTupleKey([...b, ...a]));
    assert.notEqual(recipeIngredientTupleKey(a), recipeIngredientTupleKey([{ inventoryItemId: "inv_k", quantity: 2, unit: "g" }]));
    assert.notEqual(recipeIngredientTupleKey(a), recipeIngredientTupleKey([{ inventoryItemId: "inv_k", quantity: 1, unit: "ml" }]));
  });
});

describe("M-1: service wiring", () => {
  const route = src("lib/recipeWriteService.js");

  test("activation loads the stored tuple including legacy isActive", () => {
    assert.ok(route.includes("const activating = data.isActive === true"));
    assert.ok(route.includes('select("menuItemId ingredients isActive")'));
    assert.ok(route.includes("requiresStockAreaRevalidation(current, data)"));
  });

  test("the effective stored tuple is validated, not the client payload", () => {
    assert.ok(route.includes("? data.ingredients"));
    assert.ok(route.includes(": current.ingredients || []"));
    assert.ok(route.includes("validateRecipeStockArea({"));
    assert.ok(route.includes("RECIPE_MENU_ITEM_NOT_FOUND"));
  });
});

// ---------------------------------------------------------------------------
// OBS-3b: reactivation revalidates frozen ingredient units against the
// authoritative InventoryItem unit.
// ---------------------------------------------------------------------------

const unitInventory = new Map(
  [
    { _id: "inv_g", name: "Rice", unit: "g", stockGroup: STOCK_GROUP.KITCHEN },
    { _id: "inv_kg", name: "Flour", unit: "kg", stockGroup: STOCK_GROUP.KITCHEN },
    { _id: "inv_pcs", name: "Egg", unit: "pcs", stockGroup: STOCK_GROUP.KITCHEN },
    { _id: "inv_amb", name: "Syrup", unit: "cup", stockGroup: STOCK_GROUP.KITCHEN },
    { _id: "inv_bad", name: "Mystery", unit: "stone", stockGroup: STOCK_GROUP.KITCHEN },
  ].map((item) => [item._id, item])
);

function units(rows) {
  return validateRecipeIngredientUnits({
    ingredients: rows,
    inventoryById: unitInventory,
  });
}

describe("OBS-3b: reactivation revalidates ingredient units", () => {
  test("matching units pass", () => {
    assert.deepEqual(units([{ inventoryItemId: "inv_g", quantity: 2, unit: "g" }]), {
      ok: true,
    });
    // Case/whitespace differences are the reservation layer's own same-unit rule.
    assert.equal(units([{ inventoryItemId: "inv_g", quantity: 2, unit: " G " }]).ok, true);
  });

  test("exact same-dimension conversion follows the canonical converter", () => {
    // 0.5 kg of an item stored in g is 500 g — exact, no rounding.
    assert.deepEqual(units([{ inventoryItemId: "inv_g", quantity: 0.5, unit: "kg" }]), {
      ok: true,
    });
    assert.equal(units([{ inventoryItemId: "inv_g", quantity: 1.25, unit: "kg" }]).ok, true);
  });

  test("a lossy conversion is rejected instead of rounded", () => {
    // 0.5 g is 0.0005 kg: not representable at V1's three decimals.
    const result = units([{ inventoryItemId: "inv_kg", quantity: 0.5, unit: "g" }]);
    assert.equal(result.ok, false);
    assert.equal(result.code, RECIPE_UNIT_MISMATCH);
  });

  test("cross-dimension units are rejected", () => {
    const result = units([{ inventoryItemId: "inv_pcs", quantity: 1, unit: "kg" }]);
    assert.equal(result.ok, false);
    assert.equal(result.code, RECIPE_UNIT_MISMATCH);
  });

  test("ambiguous or unsupported units fail closed on either side", () => {
    for (const row of [
      { inventoryItemId: "inv_g", quantity: 1, unit: "cup" },
      { inventoryItemId: "inv_g", quantity: 1, unit: "stone" },
      { inventoryItemId: "inv_amb", quantity: 1, unit: "cup" },
      { inventoryItemId: "inv_bad", quantity: 1, unit: "g" },
    ]) {
      const result = units([row]);
      assert.equal(result.ok, false, JSON.stringify(row));
      assert.equal(result.code, RECIPE_UNIT_MISMATCH, JSON.stringify(row));
    }
  });

  test("a missing InventoryItem is rejected, never skipped", () => {
    const result = units([{ inventoryItemId: "inv_missing", quantity: 1, unit: "g" }]);
    assert.equal(result.ok, false);
    assert.equal(result.code, RECIPE_UNIT_ITEM_NOT_FOUND);
  });

  test("missing, blank, or invalid stored values are rejected", () => {
    for (const row of [
      { inventoryItemId: "inv_g", quantity: 1, unit: "" },
      { inventoryItemId: "inv_g", quantity: 1, unit: null },
      { inventoryItemId: "inv_g", quantity: 1, unit: "   " },
      { inventoryItemId: "inv_g", quantity: 1 },
      { inventoryItemId: "inv_g", quantity: 0, unit: "g" },
      { inventoryItemId: "inv_g", quantity: "abc", unit: "g" },
      { inventoryItemId: "", quantity: 1, unit: "g" },
    ]) {
      const result = units([row]);
      assert.equal(result.ok, false, JSON.stringify(row));
    }
  });

  test("one bad row rejects the whole reactivation", () => {
    const result = units([
      { inventoryItemId: "inv_g", quantity: 1, unit: "g" },
      { inventoryItemId: "inv_pcs", quantity: 1, unit: "kg" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.code, RECIPE_UNIT_MISMATCH);
  });

  test("no ingredients means nothing to revalidate", () => {
    assert.deepEqual(units([]), { ok: true });
  });
});

describe("OBS-3b: reactivation is the only PATCH that runs the unit gate", () => {
  test("only an explicit false -> true transition is a reactivation", () => {
    assert.equal(isRecipeReactivation({ isActive: false }, { isActive: true }), true);
    assert.equal(isRecipeReactivation({ isActive: true }, { isActive: true }), false);
    assert.equal(isRecipeReactivation({ isActive: true }, { isActive: false }), false);
    assert.equal(isRecipeReactivation({}, { isActive: true }), false, "legacy active");
    assert.equal(isRecipeReactivation({ isActive: false }, { name: "x" }), false);
    assert.equal(isRecipeReactivation(null, { isActive: true }), false);
  });

  test("the stock-area decision still uses the same transition rule", () => {
    assert.equal(
      requiresStockAreaRevalidation({ isActive: false }, { isActive: true }),
      true
    );
    assert.equal(
      requiresStockAreaRevalidation({ isActive: true }, { isActive: true }),
      false
    );
  });

  test("the service runs the unit gate before the Recipe write", () => {
    const route = src("lib/recipeWriteService.js");
    const gateIdx = route.indexOf("const unitCompat = validateRecipeIngredientUnits({");
    const writeIdx = route.indexOf("const doc = await Recipe.findOneAndUpdate(");
    assert.ok(gateIdx > 0, "the service must call the shared unit gate");
    assert.ok(writeIdx > 0, "the service must still perform the update");
    assert.ok(gateIdx < writeIdx, "unit compatibility must be checked before the write");
    assert.ok(route.includes("isRecipeReactivation(current, data)"));
    assert.ok(route.includes("ingredients: ingredientsForCheck"));
    assert.ok(route.includes("inventoryById: invById"));
    assert.ok(route.includes("throw new RecipeWriteError(unitCompat.error, 400, unitCompat.code)"));
  });
});
