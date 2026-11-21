// M-2 regression — DB-free.
//
// The Recipe edit form must never filter incomplete legacy ingredient rows out
// of the PATCH body. The builder either refuses the save (keeping the Manager's
// values) or sends the complete, validated list. An unchanged tuple sends no
// ingredients at all, so an unrelated edit cannot rewrite a legacy recipe.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRecipeEditPatch,
  recipeIngredientDraftTuple,
  INGREDIENT_ID_REQUIRED,
  INGREDIENT_QTY_INVALID,
  INGREDIENT_QTY_PRECISION,
  INGREDIENT_UNIT_REQUIRED,
  INGREDIENT_UNIT_INVALID,
  INGREDIENT_LIST_EMPTY,
} from "../lib/recipeEditDraft.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const VALID = { inventoryItemId: "507f1f77bcf86cd799439011", quantity: "2", unit: "g" };
const LEGACY_INCOMPLETE = { inventoryItemId: "507f1f77bcf86cd799439012", quantity: "1", unit: "" };

function currentRecipe(ingredients = [VALID, LEGACY_INCOMPLETE], overrides = {}) {
  return {
    _id: "recipe_1",
    menuItemId: "507f1f77bcf86cd799439013",
    isActive: true,
    ingredients,
    ...overrides,
  };
}

function formWith(ingredients, overrides = {}) {
  return {
    menuItemId: "507f1f77bcf86cd799439013",
    isActive: true,
    ingredients,
    ...overrides,
  };
}

describe("M-2: Recipe edit payload never drops rows", () => {
  test("an unrelated edit sends no ingredient array and keeps the legacy row", () => {
    const current = currentRecipe();
    const built = buildRecipeEditPatch({
      current,
      form: formWith([VALID, LEGACY_INCOMPLETE], { isActive: false }),
    });
    assert.equal(built.ok, true);
    assert.equal(built.ingredientsChanged, false);
    assert.equal("ingredients" in built.payload, false);
    assert.equal(built.payload.isActive, false);
  });

  test("an incomplete row blocks the save instead of being filtered out", () => {
    const built = buildRecipeEditPatch({
      current: currentRecipe(),
      form: formWith([
        { ...VALID, quantity: "3" },
        LEGACY_INCOMPLETE,
      ]),
    });
    assert.equal(built.ok, false);
    assert.equal(built.code, INGREDIENT_UNIT_REQUIRED);
    assert.equal(built.index, 1);
    assert.equal(built.field, "unit");
    assert.equal("ingredients" in built, false, "no reduced payload may be produced");
  });

  test("a row without an inventory item blocks with the row number", () => {
    const built = buildRecipeEditPatch({
      current: currentRecipe([VALID]),
      form: formWith([{ inventoryItemId: "", quantity: "1", unit: "g" }]),
    });
    assert.equal(built.code, INGREDIENT_ID_REQUIRED);
    assert.equal(built.index, 0);
  });

  test("invalid quantities and precision block", () => {
    const zero = buildRecipeEditPatch({
      current: currentRecipe([VALID]),
      form: formWith([{ ...VALID, quantity: "0" }]),
    });
    assert.equal(zero.code, INGREDIENT_QTY_INVALID);

    const text = buildRecipeEditPatch({
      current: currentRecipe([VALID]),
      form: formWith([{ ...VALID, quantity: "abc" }]),
    });
    assert.equal(text.code, INGREDIENT_QTY_INVALID);

    const precise = buildRecipeEditPatch({
      current: currentRecipe([VALID]),
      form: formWith([{ ...VALID, quantity: "1.2345" }]),
    });
    assert.equal(precise.code, INGREDIENT_QTY_PRECISION);
  });

  test("a missing or unsupported unit blocks", () => {
    const missing = buildRecipeEditPatch({
      current: currentRecipe([VALID]),
      form: formWith([{ ...VALID, unit: "  " }]),
    });
    assert.equal(missing.code, INGREDIENT_UNIT_REQUIRED);

    const unsupported = buildRecipeEditPatch({
      current: currentRecipe([VALID]),
      form: formWith([{ ...VALID, unit: "cup" }]),
    });
    assert.equal(unsupported.code, INGREDIENT_UNIT_INVALID);
  });

  test("explicit user removal is sent as the intended smaller list", () => {
    const built = buildRecipeEditPatch({
      current: currentRecipe(),
      form: formWith([VALID]),
    });
    assert.equal(built.ok, true);
    assert.equal(built.ingredientsChanged, true);
    assert.deepEqual(built.payload.ingredients, [
      { inventoryItemId: VALID.inventoryItemId, quantity: 2, unit: "g" },
    ]);
  });

  test("a valid edit sends every row with numeric quantities", () => {
    const second = { inventoryItemId: "507f1f77bcf86cd799439014", quantity: "0.5", unit: "kg" };
    const built = buildRecipeEditPatch({
      current: currentRecipe([VALID]),
      form: formWith([VALID, second]),
    });
    assert.equal(built.ok, true);
    assert.deepEqual(built.payload.ingredients, [
      { inventoryItemId: VALID.inventoryItemId, quantity: 2, unit: "g" },
      { inventoryItemId: second.inventoryItemId, quantity: 0.5, unit: "kg" },
    ]);
  });

  test("emptying the ingredient list is refused, not sent as a deletion", () => {
    const built = buildRecipeEditPatch({
      current: currentRecipe([VALID]),
      form: formWith([]),
    });
    assert.equal(built.ok, false);
    assert.equal(built.code, INGREDIENT_LIST_EMPTY);
  });

  test("a menu change is sent alongside the unchanged ingredient tuple", () => {
    const built = buildRecipeEditPatch({
      current: currentRecipe([VALID]),
      form: formWith([VALID], { menuItemId: "507f1f77bcf86cd799439015" }),
    });
    assert.equal(built.ok, true);
    assert.equal(built.payload.menuItemId, "507f1f77bcf86cd799439015");
    assert.equal("ingredients" in built.payload, false);
  });

  test("legacy missing isActive defaults to active on the wire", () => {
    const current = currentRecipe([VALID]);
    delete current.isActive;
    const built = buildRecipeEditPatch({
      current,
      form: formWith([VALID], { isActive: true }),
    });
    assert.equal(built.ok, true);
    assert.equal(built.payload.isActive, true);
  });

  test("the draft tuple recognizes a displayed legacy row as unchanged", () => {
    const stored = [{ inventoryItemId: "id", quantity: undefined, unit: "g" }];
    const displayed = [{ inventoryItemId: "id", quantity: "", unit: "g" }];
    assert.equal(recipeIngredientDraftTuple(stored), recipeIngredientDraftTuple(displayed));
  });
});

describe("M-2: InventoryUI wiring", () => {
  const ui = src("app/components/InventoryUI.jsx");

  test("the edit handler uses the production builder", () => {
    assert.ok(ui.includes("buildRecipeEditPatch"));
    assert.ok(ui.includes("recipeEditErrorMessage(built, t)"));
    assert.ok(ui.includes("const payload = built.payload"));
  });

  test("the old silent filter and unit substitution are gone", () => {
    const editBlock = ui.slice(
      ui.indexOf("const handleEditRecipe"),
      ui.indexOf("const handleDeactivateRecipe")
    );
    assert.ok(editBlock.length > 0, "edit handler must be present");
    assert.equal(editBlock.includes(".filter((r) => r.inventoryItemId"), false);
    assert.equal(ui.includes("unit: String(ing.unit || picked?.unit || '')"), false);
  });
});
