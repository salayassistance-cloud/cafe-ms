// inventoryDeductionService.js — Phase G1 foundation service
// SERVICE ONLY — NO INTEGRATION, NO STOCK MUTATION, NO TRANSACTION, NO API
// Future Phase G2 will call prepareInventoryDeduction(order) from payOrder after PAID.
//
// Responsibility: analyze a paid Order document and calculate required inventory usage
// via Recipe → InventoryItem relationship. Pure calculation, no database writes.

import { connectToDatabase } from "@/lib/mongodb";
import { getRecipeModel } from "@/lib/models/Recipe";
import { isRecipeActive } from "@/lib/inventoryReservationRules";
import { INVENTORY_POLICY, resolveInventoryPolicy, isTrackedRecipeUsable } from "@/lib/inventoryPolicy";

// H-1: a Recipe lookup failure is an unknown requirement state, not "no recipe".
// The reservation layer turns any non-empty `unresolved` into a blocking
// INSUFFICIENT_STOCK reservation, so a transient database error can never be
// persisted as a payable/preparable NO_INVENTORY.
export const RECIPE_LOOKUP_FAILED_REASON =
  "Recipe lookup failed - inventory requirement unresolved";

// H1.1: a policy read failure is also an unknown requirement state. Without the
// explicit policy we cannot prove a line is UNTRACKED, so the reservation must
// fail closed rather than risk deducting stock for an untracked item.
export const INVENTORY_POLICY_LOOKUP_FAILED_REASON =
  "Inventory policy lookup failed - inventory requirement unresolved";

// H1.3: an explicitly TRACKED line whose Recipe cannot produce a requirement is
// never silently skipped. These stable reasons are folded into `unresolved`, so
// the reservation layer blocks preparation/payment instead of persisting a
// payable NO_INVENTORY. Legacy UNKNOWN lines keep their existing warning-only
// behavior (an explicit `isActive: false` Recipe is intentionally untracked).
export const TRACKED_RECIPE_MISSING_REASON =
  "Tracked menu item has no Recipe - inventory requirement unresolved";
export const TRACKED_RECIPE_INACTIVE_REASON =
  "Tracked menu item Recipe is inactive - inventory requirement unresolved";
export const TRACKED_RECIPE_EMPTY_REASON =
  "Tracked menu item Recipe has no ingredients - inventory requirement unresolved";
export const TRACKED_RECIPE_SNAPSHOT_INVALID_REASON =
  "Tracked menu item captured Recipe is invalid - inventory requirement unresolved";

// Append the lookup-failure reason without disturbing reasons already recorded.
export function addRecipeLookupFailure(unresolved) {
  if (Array.isArray(unresolved) && !unresolved.includes(RECIPE_LOOKUP_FAILED_REASON)) {
    unresolved.push(RECIPE_LOOKUP_FAILED_REASON);
  }
  return unresolved;
}

export function addInventoryPolicyLookupFailure(unresolved) {
  if (
    Array.isArray(unresolved) &&
    !unresolved.includes(INVENTORY_POLICY_LOOKUP_FAILED_REASON)
  ) {
    unresolved.push(INVENTORY_POLICY_LOOKUP_FAILED_REASON);
  }
  return unresolved;
}

// H1.3: read the immutable Recipe snapshot captured on the Order. Returns null
// for legacy orders (no capture), which keeps the existing live-Recipe path
// exactly as it was; no backfill is implied or required.
export function readInventoryRecipeSnapshot(order) {
  const snapshot =
    order && typeof order === "object" ? order.inventoryRecipeSnapshot : null;
  const rows = snapshot && Array.isArray(snapshot.recipes) ? snapshot.recipes : [];
  if (rows.length === 0) return null;
  const byMenuId = new Map();
  for (const entry of rows) {
    if (!entry || entry.menuItemId == null) continue;
    byMenuId.set(String(entry.menuItemId), entry);
  }
  return byMenuId.size > 0 ? byMenuId : null;
}

// H1.4: read the immutable per-line inventory policy captured when the line was
// added. This is the authority for new-format orders; the live MenuItem policy
// must never override it.
//
//   "TRACKED" / "UNTRACKED" -> valid capture, use it
//   null                    -> genuinely legacy line (field absent); the caller
//                              keeps the existing live-policy compatibility path
//   "INVALID"               -> present but not a valid value; the caller must
//                              fail closed instead of falling back to the catalog
export const INVENTORY_POLICY_SNAPSHOT_INVALID_REASON =
  "Order line inventory policy snapshot is invalid - inventory requirement unresolved";

// H1.4: a TRACKED line must always have its order-time Recipe capture. A missing
// entry means the order document is malformed/truncated, so the requirement is
// unresolved rather than recovered from the mutable live Recipe.
export const TRACKED_RECIPE_SNAPSHOT_MISSING_REASON =
  "Tracked order line has no captured Recipe - inventory requirement unresolved";

export function readLineInventoryPolicySnapshot(line) {
  if (!line || typeof line !== "object") return null;
  if (!("inventoryPolicySnapshot" in line)) return null;
  const raw = line.inventoryPolicySnapshot;
  // Absent/null means a legacy line written before this snapshot existed.
  if (raw == null) return null;
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (value === INVENTORY_POLICY.TRACKED) return INVENTORY_POLICY.TRACKED;
  if (value === INVENTORY_POLICY.UNTRACKED) return INVENTORY_POLICY.UNTRACKED;
  return "INVALID";
}

// Aggregate one Recipe's rows into the running requirement map. Shared by the
// captured-snapshot path and the live-Recipe fallback so both use exactly the
// same row validation and unit-preserving aggregation (unit conversion stays in
// lib/inventoryReservationService.validateRequirements, unchanged).
function accumulateRecipeIngredients({
  ingredients,
  itemId,
  itemName,
  orderQuantity,
  agg,
  warnings,
  unresolved,
  sourceLabel,
}) {
  for (let row = 0; row < ingredients.length; row++) {
    const ing = ingredients[row] || {};
    const rowRef = `${sourceLabel} ${itemId} ingredient ${row + 1}`;
    const invId = String(ing.inventoryItemId || "").trim();
    if (!invId) {
      // A tracked recipe row without a stock link can never be deducted.
      // Fail closed: no placeholder id is invented, and the requirement is
      // reported as unresolved so the reservation blocks payment/preparation.
      const reason = `${rowRef} has no inventoryItemId — requirement unresolved`;
      warnings.push(reason);
      unresolved.push(reason);
      continue;
    }
    const perUnitQty = Number(ing.quantity);
    if (!Number.isFinite(perUnitQty) || perUnitQty <= 0) {
      const reason = `${rowRef} has invalid quantity ${ing.quantity} — requirement unresolved`;
      warnings.push(reason);
      unresolved.push(reason);
      continue;
    }
    const unit = String(ing.unit || "").trim();
    if (!unit) {
      const reason = `${rowRef} has no unit — requirement unresolved`;
      warnings.push(reason);
      unresolved.push(reason);
      continue;
    }
    // Calculate total for this order line: perUnitQty * orderQty
    const totalQty = perUnitQty * orderQuantity;
    const key = invId; // aggregate same inventory item
    const existing = agg.get(key);
    if (existing) {
      // If unit mismatch, keep separate entries by key+unit to avoid mixing g/kg
      if (existing.unit !== unit) {
        const altKey = `${invId}::${unit}`;
        const alt = agg.get(altKey);
        if (alt) alt.quantity += totalQty;
        else agg.set(altKey, { inventoryItemId: invId, quantity: totalQty, unit });
      } else {
        existing.quantity += totalQty;
      }
    } else {
      agg.set(key, { inventoryItemId: invId, quantity: totalQty, unit });
    }
  }
}

/**
 * Prepare inventory deduction plan for a paid order.
 * READ-ONLY: fetches recipes, calculates aggregated ingredients, returns plan + warnings.
 * Does NOT modify InventoryItem.currentStock, does NOT create StockMovement.
 *
 * `unresolved` lists required recipe rows that exist but cannot produce a safe
 * requirement (missing inventory link, quantity, or unit). It is folded into the
 * reservation layer's fail-closed state, so such an order can never become a
 * payable/preparable NO_INVENTORY.
 *
 * @param {Object} order - Order document (lean or mongoose doc) with { _id|orderId, items: [{ itemId, quantity, type, name }] }
 * @param {Object} [options] - { connection, connect } optional existing mongoose
 *   connection / connector override for DB-free tests
 * @returns {Promise<{orderId:string, ingredients:Array<{inventoryItemId:string, quantity:number, unit:string}>, deductions:Array, warnings:string[], unresolved:string[]}>}
 */
export async function prepareInventoryDeduction(order, options = {}) {
  const warnings = [];
  const unresolved = [];

  if (!order || typeof order !== "object") {
    return {
      orderId: null,
      ingredients: [],
      deductions: [],
      warnings: ["Invalid order document"],
      unresolved,
    };
  }

  const orderId = String(order._id || order.id || order.orderId || order.orderNumber || "unknown");
  const items = Array.isArray(order.items) ? order.items : [];

  if (items.length === 0) {
    warnings.push("Order has no items");
    return { orderId, ingredients: [], deductions: [], warnings, unresolved };
  }

  // Collect candidate menu itemIds to fetch recipes. Historical external lines
  // without a catalog itemId are skipped below (missing reference), never via
  // an active isExternal rule.
  const candidateIds = [];
  const validItems = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    if (!it || typeof it !== "object") {
      warnings.push(`Item[${idx}]: invalid shape — skipped`);
      continue;
    }
    if (it.cancelled === true) {
      warnings.push(`Skipped cancelled item "${it.name || "unknown"}"`);
      continue;
    }
    const rawId = it.itemId ?? it._id;
    const itemId = rawId ? String(rawId).trim() : "";
    if (!itemId) {
      warnings.push(`Skipped item "${it.name || "unknown"}": missing menu item reference (itemId)`);
      continue;
    }
    // Validate ObjectId shape loosely (24 hex) — if invalid, warn and skip
    if (!/^[a-fA-F0-9]{24}$/.test(itemId)) {
      warnings.push(`Skipped item "${it.name || "unknown"}": invalid itemId ${itemId}`);
      continue;
    }
    const qty = Number(it.quantity ?? it.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      warnings.push(`Skipped item "${it.name || "unknown"}": invalid quantity ${it.quantity}`);
      continue;
    }
    // H1.4: the line's own immutable policy capture, when present, decides
    // whether a Recipe lookup is even relevant. An UNTRACKED capture needs no
    // Recipe, and an INVALID capture fails closed below.
    const policySnapshot = readLineInventoryPolicySnapshot(it);
    if (
      policySnapshot !== INVENTORY_POLICY.UNTRACKED &&
      policySnapshot !== "INVALID"
    ) {
      candidateIds.push(itemId);
    }
    validItems.push({
      ...it,
      _itemId: itemId,
      _quantity: qty,
      _policySnapshot: policySnapshot,
    });
  }

  // D1: a line without a catalog itemId contributes no recipe ingredients, but
  // it may still carry a stock-linked Extra component. Do not return here —
  // the component loop below must run so a legacy/bypassing payload cannot be
  // charged with an empty (NO_INVENTORY) reservation. Recipe lookup stays
  // skipped when there is nothing to look up.
  if (validItems.length === 0) {
    warnings.push("No valid order items for deduction");
  }

  // Fetch recipes for these menu items (read-only, no write). The explicit
  // MenuItem policy is read alongside them so an UNTRACKED item can be excluded
  // before any Recipe-based requirement is produced.
  //
  // H1.3: lines covered by the order's immutable Recipe snapshot never read the
  // live Recipe at all. Only uncaptured (legacy) lines trigger the live read, so
  // editing, deactivating or deleting a live Recipe cannot rewrite a captured
  // requirement.
  let recipes = [];
  const policyByMenuId = new Map();
  const capturedByMenuId = readInventoryRecipeSnapshot(order);
  if (candidateIds.length > 0) {
    const uniqIds = [...new Set(candidateIds)];
    const liveRecipeIds = uniqIds.filter(
      (id) => !capturedByMenuId || !capturedByMenuId.has(id)
    );
    let conn = options.connection || null;
    if (!conn) {
      try {
        const connect = options.connect || connectToDatabase;
        conn = await connect();
      } catch (err) {
        warnings.push(`Failed to fetch recipes: ${err?.message || "unknown"}`);
        // H-1: a failed connection or query means we do not know whether this
        // order consumes stock. Fail closed by recording one stable unresolved
        // reason (existing reasons are preserved, never replaced) and return the
        // empty plan — the reservation layer converts it into a blocked state.
        addRecipeLookupFailure(unresolved);
        return { orderId, ingredients: [], deductions: [], warnings, unresolved };
      }
    }
    if (liveRecipeIds.length > 0) {
      try {
        const Recipe = getRecipeModel(conn);
        recipes = await Recipe.find({ menuItemId: { $in: liveRecipeIds } }).lean();
      } catch (err) {
        warnings.push(`Failed to fetch recipes: ${err?.message || "unknown"}`);
        addRecipeLookupFailure(unresolved);
        return { orderId, ingredients: [], deductions: [], warnings, unresolved };
      }
    }

    // H1.1: resolve the explicit policy from the catalog. A legacy/missing
    // policy stays UNKNOWN (legacy deduction behavior is preserved). A policy
    // read failure on a real connection fails closed. A DB-free stub connection
    // without a MenuItem model has no policy source; it retains legacy behavior
    // so existing DB-free deduction tests remain valid.
    let MenuItem = null;
    try {
      const { getMenuItemModel } = await import("@/lib/models/MenuItem");
      MenuItem = getMenuItemModel(conn);
    } catch {
      MenuItem = null;
    }
    if (MenuItem) {
      try {
        const menuDocs = await MenuItem.find({ _id: { $in: uniqIds } }).lean();
        for (const doc of menuDocs || []) {
          policyByMenuId.set(String(doc._id), resolveInventoryPolicy(doc));
        }
      } catch (err) {
        warnings.push(`Failed to fetch inventory policy: ${err?.message || "unknown"}`);
        addInventoryPolicyLookupFailure(unresolved);
        return { orderId, ingredients: [], deductions: [], warnings, unresolved };
      }
    }
  }

  const recipeMap = new Map(recipes.map((r) => [String(r.menuItemId), r]));

  // Aggregate ingredients by inventoryItemId
  const agg = new Map(); // inventoryItemId -> { quantity, unit }

  for (const it of validItems) {
    // H1.4: for new-format orders the per-line capture wins and is resolved
    // before the live catalog policy, so a later MenuItem reclassification can
    // never change this order's requirements. A capture that is present but not
    // TRACKED/UNTRACKED must fail closed — never fall back to the catalog.
    const linePolicy = it._policySnapshot;
    if (linePolicy === "INVALID") {
      const reason = `${INVENTORY_POLICY_SNAPSHOT_INVALID_REASON} (${it._itemId})`;
      warnings.push(reason);
      unresolved.push(reason);
      continue;
    }

    // Genuinely legacy lines (no capture) keep the exact live-policy path.
    const policy = linePolicy || policyByMenuId.get(it._itemId);

    // H1.1/H1.4: an UNTRACKED line never produces a Recipe-based stock
    // requirement, even if a Recipe document is attached to it or the catalog
    // later classifies it TRACKED.
    if (policy === INVENTORY_POLICY.UNTRACKED) {
      warnings.push(
        `Untracked menu item "${it.name || it._itemId}" (${it._itemId}) — no stock requirement`
      );
      continue;
    }

    const captured = capturedByMenuId ? capturedByMenuId.get(it._itemId) : null;

    // A captured TRACKED line must always carry its order-time Recipe. Missing
    // it means the document is malformed, so fail closed rather than recover a
    // requirement from the mutable live Recipe.
    if (linePolicy === INVENTORY_POLICY.TRACKED && !captured) {
      const reason = `${TRACKED_RECIPE_SNAPSHOT_MISSING_REASON} (${it._itemId})`;
      warnings.push(reason);
      unresolved.push(reason);
      continue;
    }

    // H1.3: a captured Recipe is authoritative for this order. It is read from
    // the Order document, so a later live edit/deactivation/deletion cannot
    // change the requirement. A malformed capture fails closed.
    if (captured) {
      if (!isTrackedRecipeUsable(captured)) {
        const reason = `${TRACKED_RECIPE_SNAPSHOT_INVALID_REASON} (${it._itemId})`;
        warnings.push(reason);
        unresolved.push(reason);
        continue;
      }
      accumulateRecipeIngredients({
        ingredients: captured.ingredients,
        itemId: it._itemId,
        orderQuantity: it._quantity,
        agg,
        warnings,
        unresolved,
        sourceLabel: "captured recipe",
      });
      continue;
    }

    // Legacy/uncaptured path. Only an explicit TRACKED item fails closed;
    // UNKNOWN keeps the historical warning-only skip so open pre-policy orders
    // remain compatible.
    const isTracked = policy === INVENTORY_POLICY.TRACKED;
    const recipe = recipeMap.get(it._itemId);
    if (!recipe) {
      if (isTracked) {
        const reason = `${TRACKED_RECIPE_MISSING_REASON} (${it._itemId})`;
        warnings.push(reason);
        unresolved.push(reason);
      } else {
        warnings.push(`Recipe missing for menu item "${it.name || it._itemId}" (${it._itemId}) — skipped`);
      }
      continue;
    }
    // H-2: only an explicit `false` is inactive. A legacy document without the
    // field is active, exactly like the D2 unit-change guard.
    if (!isRecipeActive(recipe)) {
      if (isTracked) {
        const reason = `${TRACKED_RECIPE_INACTIVE_REASON} (${it._itemId})`;
        warnings.push(reason);
        unresolved.push(reason);
      } else {
        warnings.push(`Recipe inactive for "${it.name || it._itemId}" — skipped`);
      }
      continue;
    }
    const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    if (ingredients.length === 0) {
      if (isTracked) {
        const reason = `${TRACKED_RECIPE_EMPTY_REASON} (${it._itemId})`;
        warnings.push(reason);
        unresolved.push(reason);
      } else {
        warnings.push(`Recipe for "${it.name || it._itemId}" has no ingredients — skipped`);
      }
      continue;
    }
    accumulateRecipeIngredients({
      ingredients,
      itemId: it._itemId,
      orderQuantity: it._quantity,
      agg,
      warnings,
      unresolved,
      sourceLabel: "recipe",
    });
  }

  // Also handle priced components with explicit inventory link — manual selling price is NOT cost
  // Ingredient notes (NOTE) never deduct. Priced components without valid inventory link produce explicit warning and no deduction.
  for (const origIt of items) {
    if (origIt.cancelled === true) continue; // parent cancelled => components not deducted
    const comps = Array.isArray(origIt.components) ? origIt.components : [];
    for (const comp of comps) {
      if (!comp || comp.kind !== "PRICED_COMPONENT") continue; // NOTE never deducts
      const invRaw = comp.inventoryItemId ?? comp.inventoryId;
      if (!invRaw) {
        // No link -> no deduction (explicit missing, not fabricated)
        if (comp.stockQuantity != null || comp.stockUnit != null) {
          warnings.push(`Priced component "${comp.name || "unknown"}" has stock fields but no inventoryItemId — skipped`);
        }
        continue;
      }
      const invId = String(invRaw).trim();
      if (!/^[a-fA-F0-9]{24}$/.test(invId)) {
        warnings.push(`Priced component "${comp.name || "unknown"}": invalid inventoryItemId ${invId} — skipped`);
        continue;
      }
      const sq = Number(comp.stockQuantity);
      const qty = Number(comp.quantity);
      if (!Number.isFinite(sq) || sq <= 0) {
        warnings.push(`Priced component "${comp.name || "unknown"}": invalid stockQuantity ${comp.stockQuantity} — skipped`);
        continue;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        warnings.push(`Priced component "${comp.name || "unknown"}": invalid component quantity ${comp.quantity} — skipped`);
        continue;
      }
      const unit = String(comp.stockUnit || "").trim();
      if (!unit) {
        warnings.push(`Priced component "${comp.name || "unknown"}": missing stockUnit — skipped`);
        continue;
      }
      const totalQty = sq * qty;
      const key = invId;
      const existing = agg.get(key);
      if (existing) {
        if (existing.unit !== unit) {
          const altKey = `${invId}::${unit}`;
          const alt = agg.get(altKey);
          if (alt) alt.quantity += totalQty;
          else agg.set(altKey, { inventoryItemId: invId, quantity: totalQty, unit });
        } else {
          existing.quantity += totalQty;
        }
      } else {
        agg.set(key, { inventoryItemId: invId, quantity: totalQty, unit });
      }
    }
  }

  const ingredients = [...agg.values()].map((v) => ({
    inventoryItemId: String(v.inventoryItemId),
    quantity: Math.round(v.quantity * 1000) / 1000, // keep 3 decimals, no mutation
    unit: String(v.unit),
  }));

  // No stock mutation — future Phase G2 will use this plan to $inc currentStock and insert StockMovement in transaction.
  return {
    orderId,
    ingredients,
    deductions: ingredients, // alias for alternative spec shape
    warnings,
    unresolved,
  };
}

// OBS-2: the legacy executor is retained but DISABLED.
//
// It was never wired — no application route, service, or script calls it. It is
// however still referenced by two contracts outside this file's scope:
//   1. the documented Phase G2 seam (module header above and the planner note
//      below), and
//   2. the reservedStock ownership registry
//      (lib/inventory-v2/server/ownership.js, scope "LEGACY_V1_DEDUCTION"),
//      which records it as a verified legacy writer.
// A Phase 2.3 regression test also pins the export as the documented, unwired
// executor. Removing the symbol would break those contracts, so this file
// disables the behaviour instead — the closure path D-10 explicitly permits
// ("mark it explicitly @deprecated with a test-enforced prohibition",
// docs/production-readiness/phase-2-3-deferred-risks.md).
//
// Why it must never run: the previous body decremented `currentStock` with an
// unconditional `$inc`, never touched `reservedStock`, never converted units,
// and never consulted the plan's `unresolved` flag. Wiring it beside the
// canonical reservation path would double-deduct, drive stock negative, and
// leave holds permanently inflated.
export const LEGACY_DEDUCTION_DISABLED_CODE = "LEGACY_DEDUCTION_DISABLED";

export class LegacyInventoryDeductionDisabledError extends Error {
  constructor() {
    super(
      "executeInventoryDeduction is disabled: the legacy direct deduction path " +
        "bypasses the reservation contract. Use consumeOrderInventory " +
        "(lib/inventoryReservationService.js) for canonical reservation consumption."
    );
    this.name = "LegacyInventoryDeductionDisabledError";
    this.code = LEGACY_DEDUCTION_DISABLED_CODE;
    this.status = 409;
  }
}

// @deprecated Unwired legacy executor. Never call or wire this: it cannot
// satisfy the reservation contract. It rejects before any connection lookup,
// model access, session, or write, so it can never return a false success or
// leave a partial deduction behind.
export async function executeInventoryDeduction(plan, options = {}) {
  void plan;
  void options;
  throw new LegacyInventoryDeductionDisabledError();
}

// Pure helper for unit tests without DB (calculates from provided recipes map)
// Handles both base items via recipe and priced components with direct inventory link.
// Notes (NOTE) and cancelled parent items never deduct.
export function calculateDeductionFromRecipes(order, recipeMap) {
  const warnings = [];
  if (!order || !Array.isArray(order.items)) {
    return { orderId: String(order?._id || "unknown"), ingredients: [], deductions: [], warnings: ["Invalid order"] };
  }
  const agg = new Map();
  for (const it of order.items) {
    if (it.cancelled) continue;
    if (it.itemId) {
      const recipe = recipeMap?.get(String(it.itemId));
      if (!recipe) {
        warnings.push(`Recipe missing for ${it.itemId}`);
      } else {
        for (const ing of recipe.ingredients || []) {
          const key = String(ing.inventoryItemId);
          const qty = Number(ing.quantity) * Number(it.quantity);
          const existing = agg.get(key);
          if (existing) {
            if (existing.unit !== String(ing.unit)) {
              const altKey = `${key}::${ing.unit}`;
              const alt = agg.get(altKey);
              if (alt) alt.quantity += qty;
              else agg.set(altKey, { inventoryItemId: key, quantity: qty, unit: String(ing.unit) });
            } else existing.quantity += qty;
          } else agg.set(key, { inventoryItemId: key, quantity: qty, unit: String(ing.unit) });
        }
      }
    }
    // Priced components with direct inventory link
    const comps = Array.isArray(it.components) ? it.components : [];
    for (const comp of comps) {
      if (!comp || comp.kind !== "PRICED_COMPONENT") continue;
      if (!comp.inventoryItemId) continue; // no link -> no deduction, explicit missing
      if (comp.stockQuantity == null || comp.stockUnit == null) {
        warnings.push(`Priced component "${comp.name || "unknown"}" missing stockQuantity/stockUnit — no deduction`);
        continue;
      }
      const invId = String(comp.inventoryItemId);
      const totalQty = Number(comp.stockQuantity) * Number(comp.quantity);
      if (!Number.isFinite(totalQty) || totalQty <= 0) {
        warnings.push(`Priced component "${comp.name || "unknown"}" invalid totalQty`);
        continue;
      }
      const unit = String(comp.stockUnit);
      const existing = agg.get(invId);
      if (existing) {
        if (existing.unit !== unit) {
          const altKey = `${invId}::${unit}`;
          const alt = agg.get(altKey);
          if (alt) alt.quantity += totalQty;
          else agg.set(altKey, { inventoryItemId: invId, quantity: totalQty, unit });
        } else existing.quantity += totalQty;
      } else agg.set(invId, { inventoryItemId: invId, quantity: totalQty, unit });
    }
  }
  const ingredients = [...agg.values()];
  return { orderId: String(order._id || "unknown"), ingredients, deductions: ingredients, warnings };
}
