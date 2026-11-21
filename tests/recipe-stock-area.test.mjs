// Phase B — Recipe ↔ stock-area compatibility (DB-free).
//
// Production validator: lib/recipeStockArea.js
// Production vocabulary: lib/menuStation.js + lib/inventoryCategories.js
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateRecipeStockArea,
  RECIPE_STOCK_AREA_MISMATCH,
  RECIPE_MENU_ITEM_NOT_FOUND,
  RECIPE_INVENTORY_ITEM_NOT_FOUND,
} from "../lib/recipeStockArea.js";
import { resolveMenuItemStation } from "../lib/menuStation.js";
import {
  STOCK_GROUP,
  stockGroupForStation,
} from "../lib/inventoryCategories.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const KITCHEN_ITEM = { _id: "inv_k", name: "Rice", stockGroup: STOCK_GROUP.KITCHEN };
const BARISTA_ITEM = { _id: "inv_b", name: "Milk", stockGroup: STOCK_GROUP.BARISTA };
const JEBENA_ITEM = { _id: "inv_j", name: "Coffee Beans", stockGroup: STOCK_GROUP.JEBENA };
const EXTRA_ITEM = { _id: "inv_e", name: "Extra Injera", stockGroup: STOCK_GROUP.EXTRA };
const UNCLASSIFIED_ITEM = { _id: "inv_u", name: "Legacy Item", stockGroup: null };

const inventoryById = new Map(
  [KITCHEN_ITEM, BARISTA_ITEM, JEBENA_ITEM, EXTRA_ITEM, UNCLASSIFIED_ITEM].map((item) => [
    String(item._id),
    item,
  ])
);

const menu = (fields) => ({ _id: "menu_1", name: { en: "Test Menu" }, ...fields });
const ingredient = (item) => ({ inventoryItemId: String(item._id), quantity: 1, unit: "g" });

const check = (menuItem, item) =>
  validateRecipeStockArea({
    menuItem,
    ingredients: [ingredient(item)],
    inventoryById,
  });

describe("Phase B — station → stock area mapping", () => {
  test("the three authoritative stations map to the three physical areas", () => {
    assert.equal(stockGroupForStation("KITCHEN"), STOCK_GROUP.KITCHEN);
    assert.equal(stockGroupForStation("BARISTA"), STOCK_GROUP.BARISTA);
    assert.equal(stockGroupForStation("HOT_DRINK"), STOCK_GROUP.JEBENA);
    assert.equal(stockGroupForStation("UNKNOWN"), null);
  });

  test("menu station priority is targetStation > station > categoryType", () => {
    assert.equal(resolveMenuItemStation({ targetStation: "BARISTA", station: "KITCHEN", categoryType: "FOOD" }), "BARISTA");
    assert.equal(resolveMenuItemStation({ station: "HOT_DRINK", categoryType: "FOOD" }), "HOT_DRINK");
    assert.equal(resolveMenuItemStation({ categoryType: "DRINK" }), "BARISTA");
    assert.equal(resolveMenuItemStation({ categoryType: "HOT_DRINK" }), "HOT_DRINK");
    assert.equal(resolveMenuItemStation({ categoryType: "FOOD" }), "KITCHEN");
  });
});

describe("Phase B — FOOD/DRINK/HOT_DRINK compatibility", () => {
  test("FOOD recipe with KITCHEN stock passes", () => {
    const result = check(menu({ categoryType: "FOOD", targetStation: "KITCHEN" }), KITCHEN_ITEM);
    assert.equal(result.ok, true);
    assert.equal(result.stockGroup, STOCK_GROUP.KITCHEN);
  });

  test("DRINK recipe with BARISTA stock passes", () => {
    const result = check(menu({ categoryType: "DRINK" }), BARISTA_ITEM);
    assert.equal(result.ok, true);
    assert.equal(result.station, "BARISTA");
    assert.equal(result.stockGroup, STOCK_GROUP.BARISTA);
  });

  test("HOT_DRINK recipe with JEBENA stock passes", () => {
    const result = check(menu({ categoryType: "HOT_DRINK" }), JEBENA_ITEM);
    assert.equal(result.ok, true);
    assert.equal(result.station, "HOT_DRINK");
    assert.equal(result.stockGroup, STOCK_GROUP.JEBENA);
  });

  test("cross-area ingredients are rejected in both directions", () => {
    const foodWithBarista = check(menu({ categoryType: "FOOD" }), BARISTA_ITEM);
    assert.equal(foodWithBarista.ok, false);
    assert.equal(foodWithBarista.code, RECIPE_STOCK_AREA_MISMATCH);

    const drinkWithKitchen = check(menu({ categoryType: "DRINK" }), KITCHEN_ITEM);
    assert.equal(drinkWithKitchen.ok, false);
    assert.equal(drinkWithKitchen.code, RECIPE_STOCK_AREA_MISMATCH);

    const hotWithBarista = check(menu({ categoryType: "HOT_DRINK" }), BARISTA_ITEM);
    assert.equal(hotWithBarista.ok, false);
    assert.equal(hotWithBarista.code, RECIPE_STOCK_AREA_MISMATCH);
  });

  test("EXTRA and unclassified stock are never recipe-eligible", () => {
    const extra = check(menu({ categoryType: "FOOD" }), EXTRA_ITEM);
    assert.equal(extra.ok, false);
    assert.equal(extra.code, RECIPE_STOCK_AREA_MISMATCH);
    assert.match(extra.error, /Extra Items/);

    const unclassified = check(menu({ categoryType: "FOOD" }), UNCLASSIFIED_ITEM);
    assert.equal(unclassified.ok, false);
    assert.equal(unclassified.code, RECIPE_STOCK_AREA_MISMATCH);
    assert.match(unclassified.error, /no stock area/);
  });

  test("missing menu or inventory records fail closed", () => {
    assert.equal(
      validateRecipeStockArea({ menuItem: null, ingredients: [], inventoryById }).code,
      RECIPE_MENU_ITEM_NOT_FOUND
    );
    assert.equal(
      validateRecipeStockArea({
        menuItem: menu({ categoryType: "FOOD" }),
        ingredients: [{ inventoryItemId: "does-not-exist" }],
        inventoryById,
      }).code,
      RECIPE_INVENTORY_ITEM_NOT_FOUND
    );
  });

  test("legacy records are not rewritten or auto-classified", () => {
    const legacy = { _id: "inv_legacy", name: "Old Item", stockGroup: null };
    const map = new Map([[String(legacy._id), legacy]]);
    const result = validateRecipeStockArea({
      menuItem: menu({ categoryType: "FOOD" }),
      ingredients: [ingredient(legacy)],
      inventoryById: map,
    });
    assert.equal(result.ok, false);
    assert.equal(legacy.stockGroup, null, "validator never guesses a stockGroup");
    assert.equal(legacy.name, "Old Item", "validator never edits the record");
  });
});

describe("Phase B — server-side route enforcement", () => {
  test("recipe create validates the stock area after resolving the menu item", () => {
    const post = src("lib/recipeWriteService.js");
    assert.ok(post.includes("validateRecipeStockArea"));
    assert.ok(post.includes("categoryType station targetStation"));
    assert.ok(post.includes("inventoryById"));
    assert.ok(post.includes("stockArea.code"));
  });

  test("recipe update validates changed tuples and reactivation, preserves deactivation", () => {
    const patch = src("lib/recipeWriteService.js");
    assert.ok(patch.includes("validateRecipeStockArea"));
    assert.ok(patch.includes("requiresStockAreaRevalidation"));
    assert.ok(patch.includes("if (needsCompatibility)"));
    // M-1: activation reloads the stored tuple (incl. legacy isActive) so the
    // effective full tuple is validated before a recipe can deduct again.
    assert.ok(patch.includes('select("menuItemId ingredients isActive")'));
    assert.ok(patch.includes("const activating = data.isActive === true"));
  });

  test("client-supplied station/stockGroup fields are never trusted", () => {
    const post = src("lib/recipeWriteService.js");
    const patch = src("lib/recipeWriteService.js");
    for (const source of [post, patch]) {
      assert.equal(source.includes("body.stockGroup"), false);
      assert.equal(source.includes("body.targetStation"), false);
      assert.equal(source.includes("body.station"), false);
    }
  });
});
