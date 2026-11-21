// recipeEditDraft.js — pure, dependency-free builder for the Manager Recipe
// edit PATCH payload.
//
// M-2: the edit form used to filter incomplete ingredient rows out of the
// payload. If the Manager changed any other field, the server then received a
// reduced array and deleted the legacy/incomplete rows. This module never
// filters: it either sends the complete, validated row list or refuses the save
// so the Manager can repair the row in place. When the ingredient tuple is
// unchanged, no ingredient array is sent at all (minimal PATCH), which keeps an
// unrelated metadata/activation edit from rewriting a legacy recipe.
//
// No React, no DB, no Next.js imports so the DB-free suite can exercise the
// exact production payload logic.

import { isValidInventoryUnit } from "./inventoryUnitGuard.js";

export const INGREDIENT_ID_REQUIRED = "INGREDIENT_ID_REQUIRED";
export const INGREDIENT_QTY_INVALID = "INGREDIENT_QTY_INVALID";
export const INGREDIENT_QTY_PRECISION = "INGREDIENT_QTY_PRECISION";
export const INGREDIENT_UNIT_REQUIRED = "INGREDIENT_UNIT_REQUIRED";
export const INGREDIENT_UNIT_INVALID = "INGREDIENT_UNIT_INVALID";
export const INGREDIENT_LIST_EMPTY = "INGREDIENT_LIST_EMPTY";

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function ingredientId(row) {
  return String(row?.inventoryItemId || row?.itemId || row?.inventoryItem?._id || "").trim();
}

// Raw-text comparison so a legacy row rendered into the form (for example
// quantity `undefined` shown as "") is recognized as unchanged rather than as a
// pending rewrite.
export function recipeIngredientDraftTuple(rows) {
  return listOf(rows)
    .map((row) =>
      [
        ingredientId(row),
        String(row?.unit ?? "").trim().toLowerCase(),
        String(row?.quantity ?? "").trim(),
      ].join("|")
    )
    .sort()
    .join(",");
}

/**
 * Build the PATCH body for a Recipe edit.
 *
 * @param {{ current?: object, form?: object }} input
 *   `current` is the recipe being edited; `form` is
 *   { menuItemId, ingredients: [{ inventoryItemId, quantity, unit }], isActive }.
 * @returns {{ ok: true, payload: object, ingredientsChanged: boolean }
 *   | { ok: false, code: string, index: number, field: string }}
 */
export function buildRecipeEditPatch({ current, form } = {}) {
  const stored = current || {};
  const draft = form || {};

  const formMenuId = String(draft.menuItemId || "");
  const storedMenuId = String(stored.menuItemId || stored.menuItem?._id || "");
  const ingredientsChanged =
    recipeIngredientDraftTuple(draft.ingredients) !==
    recipeIngredientDraftTuple(stored.ingredients);

  // Activation defaults to the stored value: a legacy recipe without the field
  // is active (H-2), and the UI always submits the switch position.
  const payload = { isActive: draft.isActive !== false };
  if (formMenuId !== storedMenuId) payload.menuItemId = formMenuId;

  if (!ingredientsChanged) {
    // Minimal PATCH: unrelated edits never rewrite the stored ingredient rows.
    return { ok: true, payload, ingredientsChanged: false };
  }

  const rows = listOf(draft.ingredients);
  if (rows.length === 0) {
    return { ok: false, code: INGREDIENT_LIST_EMPTY, index: -1, field: "ingredients" };
  }

  const cleaned = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const id = ingredientId(row);
    if (!id) {
      return { ok: false, code: INGREDIENT_ID_REQUIRED, index: i, field: "inventoryItemId" };
    }
    const rawQty = row.quantity;
    const qty = Number(rawQty);
    if (rawQty == null || String(rawQty).trim() === "" || !Number.isFinite(qty) || qty <= 0) {
      return { ok: false, code: INGREDIENT_QTY_INVALID, index: i, field: "quantity" };
    }
    const fraction = String(rawQty).split(".")[1];
    if (fraction && fraction.length > 3) {
      return { ok: false, code: INGREDIENT_QTY_PRECISION, index: i, field: "quantity" };
    }
    const unit = String(row.unit ?? "").trim();
    if (!unit) {
      return { ok: false, code: INGREDIENT_UNIT_REQUIRED, index: i, field: "unit" };
    }
    if (!isValidInventoryUnit(unit)) {
      return { ok: false, code: INGREDIENT_UNIT_INVALID, index: i, field: "unit" };
    }
    cleaned.push({ inventoryItemId: id, quantity: qty, unit });
  }

  payload.ingredients = cleaned;
  return { ok: true, payload, ingredientsChanged: true };
}
