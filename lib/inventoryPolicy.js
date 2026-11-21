// H1 inventory policy — explicit TRACKED / UNTRACKED classification.
//
// This module is the single DB-free authority for reading and validating a
// MenuItem's inventory policy. It deliberately contains no inference:
//
//   * Missing/null/empty policy is UNKNOWN. A legacy item is never silently
//     treated as TRACKED or UNTRACKED.
//   * Only TRACKED and UNTRACKED are valid for new writes. EXTERNAL was
//     rejected by the owner and must never be selectable or sellable again.
//   * A historical EXTERNAL value may still exist in an old document; it is
//     reported as EXTERNAL for read/reporting compatibility and is never
//     orderable.
//
// TRACKED ordering requires a usable Recipe: active, non-empty, and every row
// carries a stock id, a positive quantity, and a unit. Deeper validation
// (stock-area compatibility, unit conversion) stays in the canonical recipe
// modules and is intentionally not duplicated here.

export const INVENTORY_POLICY = Object.freeze({
  TRACKED: "TRACKED",
  UNTRACKED: "UNTRACKED",
});

export const INVENTORY_POLICY_VALUES = Object.freeze(["TRACKED", "UNTRACKED"]);

export const INVENTORY_POLICY_UNKNOWN = "UNKNOWN";
// Read-only historical marker. Never a valid write value.
export const INVENTORY_POLICY_HISTORICAL_EXTERNAL = "EXTERNAL";

export const INVENTORY_POLICY_MESSAGES = Object.freeze({
  UNKNOWN:
    "This item is not available for new orders yet. Please ask a manager to review it.",
  EXTERNAL: "This item is not available for new orders.",
  TRACKED_RECIPE:
    "This item is not available for new orders right now. Please ask a manager to review its recipe.",
});

// Neutral reason codes used by tests/logs. They are not staff-facing copy.
export const INVENTORY_POLICY_BLOCK_REASONS = Object.freeze({
  UNKNOWN: "POLICY_UNKNOWN",
  HISTORICAL_EXTERNAL: "POLICY_HISTORICAL_EXTERNAL",
  TRACKED_RECIPE: "TRACKED_RECIPE_INVALID",
});

function normalizeRaw(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * Validate an explicit policy supplied by a Manager create/update payload.
 * Absence, UNKNOWN, and historical EXTERNAL are rejected for writes.
 *
 * @param {unknown} value
 * @returns {{ok: true, policy: "TRACKED"|"UNTRACKED"} | {ok: false, error: string}}
 */
export function validateExplicitInventoryPolicy(value) {
  const raw = normalizeRaw(value);
  if (!raw) {
    return {
      ok: false,
      error: "Select how this item uses stock: track stock or do not track stock.",
    };
  }
  if (raw === INVENTORY_POLICY_HISTORICAL_EXTERNAL) {
    return {
      ok: false,
      error:
        "External items are not supported. Choose tracked stock or untracked stock.",
    };
  }
  if (!INVENTORY_POLICY_VALUES.includes(raw)) {
    return {
      ok: false,
      error: "Inventory policy must be tracked stock or untracked stock.",
    };
  }
  return { ok: true, policy: raw };
}

/**
 * Resolve the effective policy of a stored MenuItem or a raw value.
 * Missing/null/empty/invalid legacy values resolve to UNKNOWN. Historical
 * EXTERNAL is preserved as EXTERNAL for read/report compatibility only.
 *
 * @param {object|string|null|undefined} docOrValue
 * @returns {"TRACKED"|"UNTRACKED"|"UNKNOWN"|"EXTERNAL"}
 */
export function resolveInventoryPolicy(docOrValue) {
  const raw =
    typeof docOrValue === "string"
      ? docOrValue
      : docOrValue && typeof docOrValue === "object"
      ? docOrValue.inventoryPolicy
      : null;
  const value = normalizeRaw(raw);
  if (value === INVENTORY_POLICY.TRACKED) return INVENTORY_POLICY.TRACKED;
  if (value === INVENTORY_POLICY.UNTRACKED) return INVENTORY_POLICY.UNTRACKED;
  if (value === INVENTORY_POLICY_HISTORICAL_EXTERNAL) {
    return INVENTORY_POLICY_HISTORICAL_EXTERNAL;
  }
  return INVENTORY_POLICY_UNKNOWN;
}

/**
 * Manager-visible classification of a saved MenuItem, keyed by id.
 *
 * Recipe presence is deliberately not an input: a saved UNTRACKED item with a
 * Recipe stays UNTRACKED, and a saved TRACKED item with a temporarily unusable
 * Recipe stays TRACKED (its Recipe issue is reported separately by the UI).
 * A missing/unresolved value is UNKNOWN, never silently assigned. Historical
 * EXTERNAL is shown in the same explicit "needs review" bucket; it is read-only
 * and never treated as TRACKED or UNTRACKED.
 *
 * @param {Record<string, unknown>} policyById serialized saved policies by MenuItem id
 * @param {unknown} menuItemId
 * @returns {"TRACKED"|"UNTRACKED"|"UNKNOWN"}
 */
export function resolveSavedMenuItemPolicy(policyById, menuItemId) {
  const raw =
    policyById && typeof policyById === "object" && !Array.isArray(policyById)
      ? policyById[String(menuItemId)]
      : null;
  const resolved = resolveInventoryPolicy(raw);
  return resolved === INVENTORY_POLICY_HISTORICAL_EXTERNAL
    ? INVENTORY_POLICY_UNKNOWN
    : resolved;
}

/**
 * A TRACKED item may only be ordered when its Recipe can actually produce a
 * requirement. Mirrors the fail-closed row checks in
 * lib/inventoryDeductionService.js without changing that algorithm.
 *
 * @param {object|null|undefined} recipe
 * @returns {boolean}
 */
export function isTrackedRecipeUsable(recipe) {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return false;
  if (recipe.isActive === false) return false;
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  if (ingredients.length === 0) return false;
  return ingredients.every((ingredient) => {
    if (!ingredient || typeof ingredient !== "object") return false;
    const id = String(ingredient.inventoryItemId || "").trim();
    if (!/^[a-fA-F0-9]{24}$/.test(id)) return false;
    const quantity = Number(ingredient.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return false;
    if (!String(ingredient.unit || "").trim()) return false;
    return true;
  });
}

/**
 * Decide whether a NEW order line may use the item under its effective policy.
 * Open orders are never evaluated here (legacy compatibility is a gate-level
 * concern and is unchanged in this phase).
 *
 * @param {{inventoryPolicy?: unknown, recipe?: object|null, doc?: object|null}} input
 * @returns {{ok: true, policy: string} | {ok: false, policy: string, code: "ITEM_NOT_ORDERABLE", reason: string, error: string}}
 */
export function validateOrderLineInventoryPolicy(input = {}) {
  const source =
    input && typeof input === "object" && "doc" in input && input.doc
      ? input.doc
      : input;
  const policy =
    source && typeof source === "object" && "inventoryPolicy" in source
      ? resolveInventoryPolicy(source.inventoryPolicy)
      : resolveInventoryPolicy(source);

  if (policy === INVENTORY_POLICY_UNKNOWN) {
    return {
      ok: false,
      policy,
      code: "ITEM_NOT_ORDERABLE",
      reason: INVENTORY_POLICY_BLOCK_REASONS.UNKNOWN,
      error: INVENTORY_POLICY_MESSAGES.UNKNOWN,
    };
  }
  if (policy === INVENTORY_POLICY_HISTORICAL_EXTERNAL) {
    return {
      ok: false,
      policy,
      code: "ITEM_NOT_ORDERABLE",
      reason: INVENTORY_POLICY_BLOCK_REASONS.HISTORICAL_EXTERNAL,
      error: INVENTORY_POLICY_MESSAGES.EXTERNAL,
    };
  }
  if (policy === INVENTORY_POLICY.TRACKED) {
    if (!isTrackedRecipeUsable(input && input.recipe)) {
      return {
        ok: false,
        policy,
        code: "ITEM_NOT_ORDERABLE",
        reason: INVENTORY_POLICY_BLOCK_REASONS.TRACKED_RECIPE,
        error: INVENTORY_POLICY_MESSAGES.TRACKED_RECIPE,
      };
    }
    return { ok: true, policy };
  }
  return { ok: true, policy };
}
