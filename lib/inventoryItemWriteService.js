// inventoryItemWriteService.js — transactional InventoryItem PATCH (OBS-3).
//
// Extracted from app/api/inventory/items/[id]/route.js so the replica-set
// harness exercises the exact production operation. The route keeps auth,
// request parsing, payload validation and response serialization.
//
// Transaction boundary (one session, one transaction, bounded retry):
//   read before-snapshot → ExtraItem/active-Recipe D2 guards → guarded
//   InventoryItem write (+ `unitRevision` increment when the unit changes) →
//   ITEM_UPDATED / COST_UPDATED audits → commit.
//
// `unitRevision` is a write-conflict token only: it is incremented in the same
// update that changes `unit`, which makes a concurrent Recipe transaction
// conflict on the same document instead of validating a stale unit. The unit
// itself is never rewritten by Recipe coordination.

import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { getExtraItemModel } from "@/lib/models/ExtraItem";
import { getRecipeModel } from "@/lib/models/Recipe";
import { createInventoryAudit } from "@/lib/inventoryAuditService";
import { evaluateInventoryUnitChange, unitTextChanged } from "@/lib/inventoryValidation";
import { RECIPE_ACTIVE_FILTER } from "@/lib/inventoryReservationRules";
import {
  INVENTORY_COMMIT_UNKNOWN,
  INVENTORY_ITEM_CHANGED,
  InventoryItemWriteError,
} from "@/lib/recipeUnitCoordination";
import {
  isTransientTransactionError,
  isUnknownCommitResult,
  runInTransaction,
} from "@/lib/transactionRunner";

function runItemTransaction(conn, fn) {
  return runInTransaction(conn, fn, {
    makeUnavailableError: (message, status, code) =>
      new InventoryItemWriteError(message, status, code),
  }).catch((err) => {
    // The runner already stopped retrying. Map post-retry outcomes only.
    if (isUnknownCommitResult(err)) {
      throw new InventoryItemWriteError(
        "Inventory item write could not be confirmed. Reload before retrying.",
        409,
        INVENTORY_COMMIT_UNKNOWN
      );
    }
    if (isTransientTransactionError(err)) {
      throw new InventoryItemWriteError(
        "Inventory item changed while saving. Reload and retry.",
        409,
        INVENTORY_ITEM_CHANGED
      );
    }
    throw err;
  });
}

function snapshotOf(doc) {
  return {
    name: doc.name,
    category: doc.category,
    stockGroup: doc.stockGroup || null,
    unit: doc.unit,
    currentStock: Number(doc.currentStock) || 0,
    minimumStock: Number(doc.minimumStock) || 0,
    cost: Number(doc.cost) || 0,
    status: doc.status,
    supplier: doc.supplier ? String(doc.supplier) : null,
  };
}

/**
 * Update one InventoryItem (PATCH /api/inventory/items/[id]).
 *
 * @param {object} conn mongoose connection
 * @param {{ itemId: string, data: object, actor: { staffId?: string|null, role?: string|null } }} input
 *   `data` is the output of validateInventoryItemUpdate.
 * @returns {Promise<object>} the updated lean document
 */
export async function updateInventoryItem(conn, { itemId, data, actor = {} }) {
  return runItemTransaction(conn, async (session) => {
    const InventoryItem = getInventoryItemModel(conn);

    // Capture before snapshot for audit (inside transaction for consistency)
    const beforeDoc = await InventoryItem.findById(itemId).session(session).lean();
    if (!beforeDoc) throw new InventoryItemWriteError("Inventory item not found", 404);

    // D2: the stock unit is the contract between held reservation rows, the
    // Extra Items that wrap this stock item, and every active Recipe that
    // consumes it. Reject a unit change while stock is reserved by an active
    // order, while any Extra Item references this item, or while an active
    // Recipe uses it. Nothing is converted or guessed: the write is blocked
    // with 409 and the audit trail is left untouched because the item is not
    // updated.
    const nextUnit = data.unit;
    const unitChanged = unitTextChanged(beforeDoc.unit, nextUnit);
    if (unitChanged) {
      const ExtraItem = getExtraItemModel(conn);
      const extraItemLinked = !!(await ExtraItem.exists({
        inventoryItemId: itemId,
      }).session(session));
      const Recipe = getRecipeModel(conn);
      // Missing `isActive` is a legacy active recipe; only an explicit false is
      // inactive. RECIPE_ACTIVE_FILTER is the same rule deduction selection
      // uses (lib/inventoryReservationRules.js), so the two cannot drift.
      const recipeLinked = !!(await Recipe.exists({
        "ingredients.inventoryItemId": itemId,
        ...RECIPE_ACTIVE_FILTER,
      }).session(session));
      const unitChange = evaluateInventoryUnitChange({
        currentUnit: beforeDoc.unit,
        nextUnit,
        reservedStock: beforeDoc.reservedStock,
        extraItemLinked,
        recipeLinked,
      });
      if (unitChange.blocked) {
        throw new InventoryItemWriteError(
          "Unit change blocked: stock is reserved by an active order, used by an Extra Item, or used by an active Recipe",
          409,
          unitChange.code
        );
      }
    }

    // Defensive predicate: when the unit changes, the update only applies to
    // the exact unit that was validated. A direct/out-of-band unit write (or a
    // concurrent unit change) turns into a stable 409 instead of an overwrite.
    // The unitRevision increment in the same write is what makes a concurrent
    // Recipe transaction conflict.
    const filter = unitChanged
      ? { _id: itemId, unit: beforeDoc.unit ?? null }
      : { _id: itemId };
    const update = unitChanged
      ? { $set: { ...data, updatedAt: new Date() }, $inc: { unitRevision: 1 } }
      : { $set: { ...data, updatedAt: new Date() } };

    const doc = await InventoryItem.findOneAndUpdate(filter, update, {
      new: true,
      runValidators: true,
      session,
    }).lean();
    if (!doc) {
      throw new InventoryItemWriteError(
        "Inventory item changed while saving. Reload and retry.",
        409,
        INVENTORY_ITEM_CHANGED
      );
    }

    // H7.2 audit trail — via shared service (actor from session, atomic)
    // H7.3 cost history — via COST_UPDATED when persisted cost actually changes
    const changedFields = Object.keys(data);
    const reason = `Updated ${changedFields.join(", ")}`;
    await createInventoryAudit(
      conn,
      {
        itemId: String(doc._id),
        action: "ITEM_UPDATED",
        actorId: actor.staffId || null,
        actorRole: actor.role || null,
        quantityDelta: null,
        beforeStock: Number(beforeDoc.currentStock) || 0,
        afterStock: Number(doc.currentStock) || 0,
        reason: reason.slice(0, 500),
        correlationId: null,
        beforeSnapshot: snapshotOf(beforeDoc),
        afterSnapshot: snapshotOf(doc),
      },
      { session }
    );

    // H7.3: record explicit cost change only when persisted cost differs
    // (rounded to 2 decimals per validation)
    const oldCostRaw = beforeDoc.cost;
    const newCostRaw = doc.cost;
    const oldCost = oldCostRaw != null ? Math.round(Number(oldCostRaw) * 100) / 100 : 0;
    const newCost = newCostRaw != null ? Math.round(Number(newCostRaw) * 100) / 100 : 0;
    const costChanged = Number.isFinite(oldCost) && Number.isFinite(newCost) && oldCost !== newCost;
    if (costChanged) {
      await createInventoryAudit(
        conn,
        {
          itemId: String(doc._id),
          action: "COST_UPDATED",
          actorId: actor.staffId || null,
          actorRole: actor.role || null,
          oldCost: oldCost,
          newCost: newCost,
          reason: `Cost updated from ${oldCost} to ${newCost}`.slice(0, 500),
          correlationId: null,
          beforeSnapshot: null,
          afterSnapshot: null,
        },
        { session }
      );
    }

    return doc;
  });
}
