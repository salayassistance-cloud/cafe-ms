// inventoryDeductionService.js — Phase G1 foundation service
// SERVICE ONLY — NO INTEGRATION, NO STOCK MUTATION, NO TRANSACTION, NO API
// Future Phase G2 will call prepareInventoryDeduction(order) from payOrder after PAID.
//
// Responsibility: analyze a paid Order document and calculate required inventory usage
// via Recipe → InventoryItem relationship. Pure calculation, no database writes.

import { connectToDatabase } from "@/lib/mongodb";
import { getRecipeModel } from "@/lib/models/Recipe";

/**
 * Prepare inventory deduction plan for a paid order.
 * READ-ONLY: fetches recipes, calculates aggregated ingredients, returns plan + warnings.
 * Does NOT modify InventoryItem.currentStock, does NOT create StockMovement.
 *
 * @param {Object} order - Order document (lean or mongoose doc) with { _id|orderId, items: [{ itemId, quantity, type, isExternal, name }] }
 * @param {Object} [options] - { connection } optional existing mongoose connection for testability
 * @returns {Promise<{orderId:string, ingredients:Array<{inventoryItemId:string, quantity:number, unit:string}>, deductions:Array, warnings:string[]}>}
 */
export async function prepareInventoryDeduction(order, options = {}) {
  const warnings = [];

  if (!order || typeof order !== "object") {
    return { orderId: null, ingredients: [], deductions: [], warnings: ["Invalid order document"] };
  }

  const orderId = String(order._id || order.id || order.orderId || order.orderNumber || "unknown");
  const items = Array.isArray(order.items) ? order.items : [];

  if (items.length === 0) {
    warnings.push("Order has no items");
    return { orderId, ingredients: [], deductions: [], warnings };
  }

  // Collect candidate menu itemIds to fetch recipes (skip external / no ref)
  const candidateIds = [];
  const validItems = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    if (!it || typeof it !== "object") {
      warnings.push(`Item[${idx}]: invalid shape — skipped`);
      continue;
    }
    if (it.isExternal === true) {
      warnings.push(`Skipped external item "${it.name || "unknown"}"`);
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
    // Keep for recipe lookup
    candidateIds.push(itemId);
    validItems.push({ ...it, _itemId: itemId, _quantity: qty });
  }

  if (validItems.length === 0) {
    warnings.push("No valid order items for deduction");
    return { orderId, ingredients: [], deductions: [], warnings };
  }

  // Fetch recipes for these menu items (read-only, no write)
  let recipes = [];
  try {
    const conn = options.connection || (await connectToDatabase());
    const Recipe = getRecipeModel(conn);
    // Unique ids
    const uniqIds = [...new Set(candidateIds)];
    recipes = await Recipe.find({ menuItemId: { $in: uniqIds } }).lean();
  } catch (err) {
    warnings.push(`Failed to fetch recipes: ${err?.message || "unknown"}`);
    return { orderId, ingredients: [], deductions: [], warnings };
  }

  const recipeMap = new Map(recipes.map((r) => [String(r.menuItemId), r]));

  // Aggregate ingredients by inventoryItemId
  const agg = new Map(); // inventoryItemId -> { quantity, unit }

  for (const it of validItems) {
    const recipe = recipeMap.get(it._itemId);
    if (!recipe) {
      warnings.push(`Recipe missing for menu item "${it.name || it._itemId}" (${it._itemId}) — skipped`);
      continue;
    }
    if (!recipe.isActive) {
      warnings.push(`Recipe inactive for "${it.name || it._itemId}" — skipped`);
      continue;
    }
    const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    if (ingredients.length === 0) {
      warnings.push(`Recipe for "${it.name || it._itemId}" has no ingredients — skipped`);
      continue;
    }
    for (const ing of ingredients) {
      const invId = String(ing.inventoryItemId || "").trim();
      if (!invId) {
        warnings.push(`Skipped ingredient with missing inventoryItemId in recipe ${it._itemId}`);
        continue;
      }
      const perUnitQty = Number(ing.quantity);
      if (!Number.isFinite(perUnitQty) || perUnitQty <= 0) {
        warnings.push(`Skipped ingredient ${invId}: invalid per-unit quantity ${ing.quantity}`);
        continue;
      }
      const unit = String(ing.unit || "").trim();
      if (!unit) {
        warnings.push(`Skipped ingredient ${invId}: missing unit`);
        continue;
      }
      // Calculate total for this order line: perUnitQty * orderQty
      const totalQty = perUnitQty * it._quantity;
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
  };
}

// Execute prepared deduction plan — minimal Phase G2 execution layer
// Responsibilities: idempotency check, transactional $inc + StockMovement OUT/SaleDeduction
export async function executeInventoryDeduction(plan, options = {}) {
  const warnings = [];
  if (!plan || typeof plan !== "object") {
    return { success: false, warnings: ["Invalid deduction plan"] };
  }
  const orderId = plan.orderId ? String(plan.orderId).trim() : "";
  const ingredients = Array.isArray(plan.ingredients) ? plan.ingredients : Array.isArray(plan.deductions) ? plan.deductions : [];
  if (!orderId || orderId === "unknown") {
    return { success: false, warnings: ["Missing orderId in plan"] };
  }
  if (ingredients.length === 0) {
    return { success: true, warnings: [...(plan.warnings || []), "No ingredients to deduct"] };
  }

  let conn = options.connection || null;
  try {
    if (!conn) {
      const { connectToDatabase } = await import("@/lib/mongodb");
      conn = await connectToDatabase();
    }
    const { getStockMovementModel } = await import("@/lib/models/StockMovement");
    const { getInventoryItemModel } = await import("@/lib/models/InventoryItem");
    const StockMovement = getStockMovementModel(conn);
    const InventoryItem = getInventoryItemModel(conn);

    // Idempotency: if a SaleDeduction movement already exists for this order, skip
    let refOrderIdQuery = orderId;
    try {
      const mongoose = (await import("mongoose")).default;
      if (mongoose.isValidObjectId(orderId)) refOrderIdQuery = new mongoose.Types.ObjectId(orderId);
    } catch {}
    const existing = await StockMovement.findOne({ refOrderId: refOrderIdQuery, reason: "SaleDeduction" }).lean();
    if (existing) {
      return { success: true, warnings: ["Deduction already exists — skipped"], skipped: true };
    }
    if (typeof refOrderIdQuery !== "string") {
      const existingStr = await StockMovement.findOne({ refOrderId: orderId, reason: "SaleDeduction" }).lean();
      if (existingStr) return { success: true, warnings: ["Deduction already exists — skipped"], skipped: true };
    }

    // Transaction: InventoryItem $inc + StockMovement insert — single session
    const session = await conn.startSession();
    try {
      session.startTransaction();
      const bulkOps = [];
      const movementDocs = [];
      const actorId = options.actorId || options.createdBy || null;
      let actorOid = null;
      if (actorId) {
        try {
          const mongoose = (await import("mongoose")).default;
          if (mongoose.isValidObjectId(String(actorId))) actorOid = new mongoose.Types.ObjectId(String(actorId));
        } catch {}
      }
      for (const ing of ingredients) {
        const invId = String(ing.inventoryItemId || "").trim();
        const qty = Number(ing.quantity);
        if (!invId || !/^[a-fA-F0-9]{24}$/.test(invId) || !Number.isFinite(qty) || qty <= 0) {
          warnings.push(`Skipped invalid ingredient ${invId} qty ${ing.quantity}`);
          continue;
        }
        bulkOps.push({
          updateOne: {
            filter: { _id: invId },
            update: { $inc: { currentStock: -qty } },
          },
        });
        const movement = {
          item: invId,
          type: "OUT",
          quantity: qty,
          reason: "SaleDeduction",
          refOrderId: refOrderIdQuery,
          notes: `Sale deduction for order ${orderId}`,
        };
        if (actorOid) movement.createdBy = actorOid;
        movementDocs.push(movement);
      }
      if (bulkOps.length > 0) {
        await InventoryItem.bulkWrite(bulkOps, { session });
      }
      if (movementDocs.length > 0) {
        await StockMovement.insertMany(movementDocs, { session });
      }
      await session.commitTransaction();
      return { success: true, warnings, moved: movementDocs.length };
    } catch (txErr) {
      try {
        await session.abortTransaction();
      } catch {}
      throw txErr;
    } finally {
      try {
        await session.endSession();
      } catch {}
    }
  } catch (err) {
    return { success: false, warnings: [...warnings, err?.message || "Deduction execution failed"], error: err?.message };
  }
}

// Pure helper for unit tests without DB (calculates from provided recipes map)
export function calculateDeductionFromRecipes(order, recipeMap) {
  const warnings = [];
  if (!order || !Array.isArray(order.items)) {
    return { orderId: String(order?._id || "unknown"), ingredients: [], deductions: [], warnings: ["Invalid order"] };
  }
  const agg = new Map();
  for (const it of order.items) {
    if (it.isExternal || !it.itemId) continue;
    const recipe = recipeMap?.get(String(it.itemId));
    if (!recipe) {
      warnings.push(`Recipe missing for ${it.itemId}`);
      continue;
    }
    for (const ing of recipe.ingredients || []) {
      const key = String(ing.inventoryItemId);
      const qty = Number(ing.quantity) * Number(it.quantity);
      const existing = agg.get(key);
      if (existing) existing.quantity += qty;
      else agg.set(key, { inventoryItemId: key, quantity: qty, unit: String(ing.unit) });
    }
  }
  const ingredients = [...agg.values()];
  return { orderId: String(order._id || "unknown"), ingredients, deductions: ingredients, warnings };
}
