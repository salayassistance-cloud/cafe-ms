// recipeUnitCoordination.js — pure OBS-3 coordination decisions and writes.
//
// The authoritative InventoryItem.unit is never rewritten here. This module
// only decides *which* InventoryItem documents a committed Recipe write must
// touch (a single `$inc: { unitRevision: 1 }` each) so MongoDB's transaction
// write-conflict detection serializes the Recipe write with any concurrent
// unit change.
//
// No database access, no Mongoose imports, no side effects: the DB-free suite
// exercises these functions directly. Coordination always uses the resulting
// *active* Recipe reference set; removed ingredients are intentionally
// excluded (the committed Recipe no longer references them).
//
// Activity rules are reused from the canonical modules:
//   * isRecipeActive          — lib/inventoryReservationRules.js (D2/H-2)
//   * isRecipeReactivation    — lib/recipeStockArea.js (OBS-3b/M-1)
// No second activity predicate exists.

import { isRecipeActive } from "./inventoryReservationRules.js";
import { isRecipeReactivation } from "./recipeStockArea.js";

// Stable client-visible codes for post-retry outcomes.
export const RECIPE_UNIT_CHANGED = "RECIPE_UNIT_CHANGED";
export const INVENTORY_ITEM_CHANGED = "INVENTORY_ITEM_CHANGED";
export const RECIPE_COMMIT_UNKNOWN = "RECIPE_COMMIT_UNKNOWN";
export const INVENTORY_COMMIT_UNKNOWN = "INVENTORY_COMMIT_UNKNOWN";

// Typed errors thrown from inside a transaction callback. The runner sees no
// transient label, so validation/business failures are never retried; the
// routes map them back to the existing sanitized response envelope.
export class RecipeWriteError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = "RecipeWriteError";
    this.status = status;
    if (code) this.code = code;
  }
}

export class InventoryItemWriteError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = "InventoryItemWriteError";
    this.status = status;
    if (code) this.code = code;
  }
}

export function isRecipeWriteError(err) {
  return err instanceof RecipeWriteError;
}

export function isInventoryItemWriteError(err) {
  return err instanceof InventoryItemWriteError;
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeId(value) {
  const s = String(value ?? "").trim();
  return s ? s.toLowerCase() : "";
}

/**
 * Collect the deterministic, deduplicated coordination set.
 *
 * Canonical ObjectId text is lowercase, so lowercasing is a normalisation, not
 * an alias. Empty/blank references are dropped; a malformed reference is
 * rejected earlier by recipe validation and never silently skipped by the
 * services.
 *
 * @param {Array<{inventoryItemId?: unknown}>|null|undefined} ingredients
 * @returns {string[]} sorted unique ids (new array; inputs are not mutated)
 */
export function collectAffectedInventoryItemIds(ingredients) {
  const ids = new Set();
  for (const ingredient of Array.isArray(ingredients) ? ingredients : []) {
    const id = normalizeId(ingredient?.inventoryItemId);
    if (id) ids.add(id);
  }
  return [...ids].sort(compareIds);
}

/**
 * Build ordered `bulkWrite` operations for the coordination token.
 * Sorting inside the builder makes the write order deterministic even if a
 * caller passes an unsorted list.
 *
 * @param {string[]|null|undefined} ids
 * @returns {Array<{updateOne: {filter: {_id: string}, update: {$inc: {unitRevision: number}}}}>}
 */
export function buildUnitRevisionWrites(ids) {
  const normalized = collectAffectedInventoryItemIds(
    (Array.isArray(ids) ? ids : []).map((id) => ({ inventoryItemId: id }))
  );
  return normalized.map((id) => ({
    updateOne: {
      filter: { _id: id },
      update: { $inc: { unitRevision: 1 } },
    },
  }));
}

/**
 * Decide whether a Recipe write participates in unit coordination.
 *
 * - POST always coordinates (validateRecipeCreate cannot set isActive; the
 *   schema default is active).
 * - An ingredient change on a Recipe that remains active coordinates.
 * - Reactivation coordinates with the effective stored rows (or the payload
 *   when it also changes ingredients).
 * - Deactivation, inactive ingredient edits, menu-only changes and no-op
 *   PATCHes do not coordinate.
 * - Removed ingredients are excluded: the committed Recipe no longer
 *   references them.
 *
 * @param {{
 *   isCreate?: boolean,
 *   current?: object|null,
 *   nextIsActive?: boolean,
 *   changesIngredients?: boolean,
 *   nextIngredients?: Array<{inventoryItemId?: unknown}>|null
 * }} input
 * @returns {{participate: boolean, ids: string[]}}
 */
export function shouldCoordinateRecipeWrite({
  isCreate = false,
  current = null,
  nextIsActive,
  changesIngredients = false,
  nextIngredients = null,
} = {}) {
  if (isCreate) {
    return { participate: true, ids: collectAffectedInventoryItemIds(nextIngredients) };
  }

  // undefined means "isActive not in the PATCH": the current state carries on
  // (missing/legacy isActive is active — the canonical rule).
  const nextActive =
    nextIsActive === undefined ? isRecipeActive(current) : nextIsActive === true;
  if (!nextActive) return { participate: false, ids: [] };

  const reactivating = isRecipeReactivation(current, { isActive: nextIsActive === true });
  if (!changesIngredients && !reactivating) return { participate: false, ids: [] };

  const effectiveIngredients = changesIngredients
    ? nextIngredients
    : current?.ingredients || [];

  return { participate: true, ids: collectAffectedInventoryItemIds(effectiveIngredients) };
}
