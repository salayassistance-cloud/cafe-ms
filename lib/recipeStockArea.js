// recipeStockArea.js — pure Recipe ↔ stock-area compatibility check.
//
// A MenuItem is prepared at exactly one station, and that station owns one
// physical stock area:
//
//   FOOD      → KITCHEN
//   DRINK     → BARISTA
//   HOT_DRINK → JEBENA
//
// Every ingredient of a tracked Recipe must consume inventory that physically
// lives in that area. This module deliberately contains no inference:
// `InventoryItem.stockGroup` is authoritative, `null`/unknown stays
// unclassified and fails closed, and `EXTRA` stock is never recipe-eligible.
// Legacy records are never rewritten — this only gates new/modified recipes.
//
// Dependency-free (relative imports, no DB/Next runtime) so the DB-free suite
// can exercise the exact production logic.

import { resolveMenuItemStation } from "./menuStation.js";
import {
  STOCK_GROUP,
  normalizeStockGroup,
  stockGroupForStation,
} from "./inventoryCategories.js";
import { validateInventoryUnit } from "./inventoryUnitGuard.js";
import { convertRequirementToStockUnit } from "./inventoryRequirementConversion.js";
import { sameUnit } from "./inventoryReservationRules.js";

export const RECIPE_STOCK_AREA_MISMATCH = "RECIPE_STOCK_AREA_MISMATCH";
export const RECIPE_MENU_ITEM_NOT_FOUND = "RECIPE_MENU_ITEM_NOT_FOUND";
export const RECIPE_INVENTORY_ITEM_NOT_FOUND = "RECIPE_INVENTORY_ITEM_NOT_FOUND";
// OBS-3b: a Recipe may only (re)start deducting when every stored ingredient
// row is still expressible in the InventoryItem's current stock unit.
export const RECIPE_UNIT_MISMATCH = "RECIPE_UNIT_MISMATCH";
export const RECIPE_UNIT_ITEM_NOT_FOUND = "RECIPE_UNIT_ITEM_NOT_FOUND";

function displayName(value, fallback) {
  if (value && typeof value === "object") {
    return value.en || value.am || value.om || fallback;
  }
  return value ? String(value) : fallback;
}

function lookup(inventoryById, id) {
  if (!inventoryById) return null;
  if (typeof inventoryById.get === "function") return inventoryById.get(id) || null;
  return inventoryById[id] || null;
}

/**
 * Validate that every ingredient belongs to the stock area implied by the
 * MenuItem's authoritative station.
 *
 * @param {{
 *   menuItem: object|null,
 *   ingredients: Array<{inventoryItemId: string}>,
 *   inventoryById: Map<string, object>|Record<string, object>
 * }} input
 * @returns {{
 *   ok: boolean,
 *   code?: string,
 *   error?: string,
 *   station?: string,
 *   stockGroup?: string
 * }}
 */
export function validateRecipeStockArea({ menuItem, ingredients, inventoryById } = {}) {
  if (!menuItem) {
    return {
      ok: false,
      code: RECIPE_MENU_ITEM_NOT_FOUND,
      error: "Menu item not found",
    };
  }

  const station = resolveMenuItemStation(menuItem);
  const expected = stockGroupForStation(station);
  if (!expected) {
    // Every supported station maps to an area. An unmapped one is a defect and
    // must fail closed rather than allow an unchecked recipe.
    return {
      ok: false,
      code: RECIPE_STOCK_AREA_MISMATCH,
      error: `No stock area is defined for station ${station}`,
    };
  }

  const list = Array.isArray(ingredients) ? ingredients : [];
  for (const ingredient of list) {
    const id = String(ingredient?.inventoryItemId ?? "");
    const item = lookup(inventoryById, id);
    if (!item) {
      return {
        ok: false,
        code: RECIPE_INVENTORY_ITEM_NOT_FOUND,
        error: `Inventory item ${id} not found`,
      };
    }

    const label = displayName(item.name, id);
    const group = normalizeStockGroup(item.stockGroup);

    // Unclassified (null/missing/unknown text) is never guessed from category,
    // name, menu type, or usage — a tracked recipe must fail closed.
    if (!group) {
      return {
        ok: false,
        code: RECIPE_STOCK_AREA_MISMATCH,
        error: `Ingredient "${label}" has no stock area; assign Kitchen, Barista, or Jebena stock before using it in a recipe`,
      };
    }

    if (group === STOCK_GROUP.EXTRA) {
      return {
        ok: false,
        code: RECIPE_STOCK_AREA_MISMATCH,
        error: `Ingredient "${label}" is Extra Items stock and cannot be used in a recipe`,
      };
    }

    if (group !== expected) {
      return {
        ok: false,
        code: RECIPE_STOCK_AREA_MISMATCH,
        error: `Ingredient "${label}" belongs to ${group} stock but this menu item is prepared at ${station} (${expected} stock)`,
      };
    }
  }

  return { ok: true, station, stockGroup: expected };
}

/**
 * OBS-3b: validate every stored Recipe ingredient against the authoritative
 * InventoryItem unit before the Recipe may be (re)activated.
 *
 * A deactivated Recipe does not block an InventoryItem unit change, so its
 * stored rows can drift (e.g. the row still says `kg` while the item now counts
 * in `g`). Reactivation is the last gate before the rows can deduct stock
 * again, so every row must be:
 *
 *   - backed by an existing InventoryItem (missing is rejected, never skipped);
 *   - valid under the canonical write vocabulary on both sides;
 *   - equal to the stock unit, or exactly convertible into it through the
 *     existing `convertRequirementToStockUnit` engine (no rounding, no aliases).
 *
 * `sameUnit` is the reservation layer's own text rule, so this gate cannot
 * disagree with the deduction path about what "already the same unit" means.
 *
 * @param {{
 *   ingredients: Array<{inventoryItemId: string, quantity: number, unit: string}>,
 *   inventoryById: Map<string, object>|Record<string, object>
 * }} input
 * @returns {{ok: true} | {ok: false, code: string, error: string, inventoryItemId?: string}}
 */
export function validateRecipeIngredientUnits({ ingredients, inventoryById } = {}) {
  const list = Array.isArray(ingredients) ? ingredients : [];

  for (const ingredient of list) {
    const id = String(ingredient?.inventoryItemId ?? "").trim();
    if (!id) {
      return {
        ok: false,
        code: RECIPE_UNIT_ITEM_NOT_FOUND,
        error: "Recipe ingredient has no inventory item reference",
      };
    }

    const item = lookup(inventoryById, id);
    if (!item) {
      return {
        ok: false,
        code: RECIPE_UNIT_ITEM_NOT_FOUND,
        error: `Inventory item ${id} not found`,
        inventoryItemId: id,
      };
    }

    const label = displayName(item.name, id);
    const stockUnit = typeof item.unit === "string" ? item.unit.trim() : "";
    const stockCheck = validateInventoryUnit(stockUnit, "inventory unit");
    if (!stockCheck.ok) {
      return {
        ok: false,
        code: RECIPE_UNIT_MISMATCH,
        error: `Ingredient "${label}" has an unsupported inventory unit "${stockUnit}" — reactivation blocked`,
        inventoryItemId: id,
      };
    }

    const recipeUnitRaw = ingredient?.unit;
    const recipeUnit = typeof recipeUnitRaw === "string" ? recipeUnitRaw.trim() : "";
    if (!recipeUnit) {
      return {
        ok: false,
        code: RECIPE_UNIT_MISMATCH,
        error: `Ingredient "${label}" has no recipe unit — reactivation blocked`,
        inventoryItemId: id,
      };
    }
    const recipeCheck = validateInventoryUnit(recipeUnit, "recipe unit");
    if (!recipeCheck.ok) {
      return {
        ok: false,
        code: RECIPE_UNIT_MISMATCH,
        error: `Ingredient "${label}" recipe unit "${recipeUnit}" is not supported — reactivation blocked`,
        inventoryItemId: id,
      };
    }

    const quantity = Number(ingredient?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return {
        ok: false,
        code: RECIPE_UNIT_MISMATCH,
        error: `Ingredient "${label}" has an invalid quantity — reactivation blocked`,
        inventoryItemId: id,
      };
    }

    // Identical text keeps the existing V1 semantics; both sides were already
    // vocabulary-checked above, so cup/cup cannot ride this fast path.
    if (sameUnit(recipeUnit, stockUnit)) continue;

    const conversion = convertRequirementToStockUnit(quantity, recipeUnit, stockUnit);
    if (!conversion.ok) {
      return {
        ok: false,
        code: RECIPE_UNIT_MISMATCH,
        error: `Ingredient "${label}" unit "${recipeUnit}" cannot be converted to inventory unit "${stockUnit}" — reactivation blocked (${conversion.code})`,
        inventoryItemId: id,
      };
    }
  }

  return { ok: true };
}

// OBS-3b: one activation-transition rule, shared by the compatibility decision
// and the unit gate so the route cannot validate a different set of rows than
// the one it re-checks for stock area. Missing/legacy `isActive` means active.
export function isRecipeReactivation(current, next) {
  return next?.isActive === true && current?.isActive === false;
}

// H-2: only an explicit `false` is inactive; missing/legacy is active. Kept
// here (next to the validator) so the edit gate and the validator agree.

export function recipeIngredientTupleKey(ingredients) {
  return (Array.isArray(ingredients) ? ingredients : [])
    .map((ing) =>
      [
        String(ing?.inventoryItemId ?? ""),
        String(ing?.unit ?? "").trim().toLowerCase(),
        String(ing?.quantity ?? "").trim(),
      ].join("|")
    )
    .sort()
    .join(",");
}

// M-1: decide whether a Recipe PATCH must re-run the stock-area validator.
// Activation is included: an inactive legacy recipe must be re-checked before
// it can deduct stock again. Deactivation (active → false) stays unchecked so
// incompatible legacy recipes can always be switched off. Unrelated edits on an
// unchanged tuple keep the legacy record untouched.
export function requiresStockAreaRevalidation(current, next) {
  if (!next || typeof next !== "object") return false;
  const reactivating = isRecipeReactivation(current, next);
  const menuChanged =
    next.menuItemId != null && String(next.menuItemId) !== String(current?.menuItemId || "");
  const ingredientsChanged =
    next.ingredients != null &&
    recipeIngredientTupleKey(next.ingredients) !== recipeIngredientTupleKey(current?.ingredients);
  return reactivating || menuChanged || ingredientsChanged;
}
