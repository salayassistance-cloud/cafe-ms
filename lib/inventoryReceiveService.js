import mongoose from "mongoose";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { getStockMovementModel } from "@/lib/models/StockMovement";
import { createInventoryAudit } from "@/lib/inventoryAuditService";
import { isDbError } from "@/lib/apiResponse";

// Explicit ServiceError for intentional HTTP business responses.
// Only this marker may be mapped to fail(message,status) in the route.
// Raw DB errors and audit validation errors (status 400) are NOT this type
// and are re-thrown unchanged so withApi preserves 503/500 behavior.
export class ReceiveServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "ReceiveServiceError";
    this._isReceiveServiceError = true;
  }
}

export function isReceiveServiceError(err) {
  return !!err && (err instanceof ReceiveServiceError || err._isReceiveServiceError === true);
}

// Precise duplicate classification prevents mis-treating unrelated 11000 errors
// (e.g. refOrderId unique index) as idempotency collisions. Uses keyPattern/keyValue when available,
// falls back to a scoped message check. The unique DB index remains the concurrency authority;
// pre-transaction findOne is a fast replay optimization, not a race preventer (snapshot reads alone do not guarantee uniqueness).
export function isIdempotencyDuplicateKeyError(err) {
  if (!err || err.code !== 11000) return false;
  const kp = err.keyPattern;
  if (kp && typeof kp === "object" && Object.prototype.hasOwnProperty.call(kp, "idempotencyKey")) return true;
  const kv = err.keyValue;
  if (kv && typeof kv === "object" && Object.prototype.hasOwnProperty.call(kv, "idempotencyKey")) return true;
  const msg = String(err.message || err.errmsg || "");
  if (/index:\s*idempotencyKey/i.test(msg)) return true;
  if (/duplicate key.*idempotencyKey/i.test(msg)) return true;
  if (/E11000.*idempotencyKey/i.test(msg)) return true;
  return false;
}

export function isSameReceivePayload(existing, payload) {
  const { itemId, quantity, unit, roundedUnitCost, supplier } = payload;
  const sameItem = String(existing.item) === String(itemId);
  const sameQty = Number(existing.quantity) === Number(quantity);
  const sameUnit = String(existing.unit || "").trim().toLowerCase() === String(unit || existing.unit || "").trim().toLowerCase();
  const sameCost = Number(existing.unitCost) === Number(roundedUnitCost);
  const sameSupplier = String(existing.supplier || "") === String(supplier || "");
  return sameItem && sameQty && sameUnit && sameCost && sameSupplier;
}

// Service owns the receiving transaction logic. Receives explicit conn; does NOT import lib/mongodb or env.
export async function receiveInventory(conn, payload) {
  const { itemId, quantity, roundedUnitCost, unit, notes, supplier, idempotencyKey, actor } = payload;

  let actorOid = null;
  if (actor && actor.staffId && mongoose.isValidObjectId(String(actor.staffId))) {
    actorOid = new mongoose.Types.ObjectId(String(actor.staffId));
  }

  // Idempotency: pre-transaction fast replay check (outside transaction).
  // Handles already-committed receipts without starting a transaction. This is NOT the concurrency
  // authority — snapshot reads alone cannot prevent races; the unique partial index on
  // idempotencyKey (lib/models/StockMovement.js) is the authority, and the error path below
  // re-reads the winning movement after a specifically identified duplicate-key error.
  const StockMovementForCheck = getStockMovementModel(conn);
  const existingForIdempotency = await StockMovementForCheck.findOne({ idempotencyKey, reason: "Purchase" }).lean();
  if (existingForIdempotency) {
    const same = isSameReceivePayload(existingForIdempotency, { itemId, quantity, unit, roundedUnitCost, supplier });
    if (!same) {
      throw new ReceiveServiceError("Idempotency-Key already used with different payload", 409);
    }
    // Same key + same payload -> replay original completed receipt
    const InventoryItemForReplay = getInventoryItemModel(conn);
    const replayItem = await InventoryItemForReplay.findById(itemId).select("_id name unit currentStock cost").lean();
    if (!replayItem) throw new ReceiveServiceError("Inventory item not found", 404);
    return {
      status: 200,
      data: {
        item: {
          _id: String(replayItem._id),
          name: replayItem.name,
          unit: replayItem.unit,
          currentStock: Number(replayItem.currentStock) || 0,
          cost: Number(replayItem.cost) || 0,
        },
        movement: {
          _id: String(existingForIdempotency._id),
          item: String(existingForIdempotency.item),
          type: existingForIdempotency.type,
          quantity: Number(existingForIdempotency.quantity),
          reason: existingForIdempotency.reason,
          unit: existingForIdempotency.unit,
          unitCost: Number(existingForIdempotency.unitCost),
          totalCost: Number(existingForIdempotency.totalCost),
          notes: existingForIdempotency.notes,
          supplier: existingForIdempotency.supplier ? String(existingForIdempotency.supplier) : null,
          idempotencyKey: existingForIdempotency.idempotencyKey || null,
        },
        previousStock: Number(replayItem.currentStock) - Number(existingForIdempotency.quantity),
        newStock: Number(replayItem.currentStock) || 0,
        costUpdatePolicy: "latest-cost-overwrite",
        replayed: true,
      },
    };
  }

  // H7.5 waste-style bounded retry for TransientTransactionError only
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = await conn.startSession();
    try {
      session.startTransaction();

      const InventoryItem = getInventoryItemModel(conn);
      const item = await InventoryItem.findById(itemId).session(session).select("_id name status unit currentStock cost supplier").lean();
      if (!item) {
        try { await session.abortTransaction(); } catch {}
        throw new ReceiveServiceError("Inventory item not found", 404);
      }
      if (item.status && String(item.status).toLowerCase() === "inactive") {
        try { await session.abortTransaction(); } catch {}
        throw new ReceiveServiceError("Cannot receive for inactive item", 400);
      }

      // Validate unit consistency if provided
      if (unit && item.unit && String(item.unit).trim().toLowerCase() !== String(unit).trim().toLowerCase()) {
        try { await session.abortTransaction(); } catch {}
        throw new ReceiveServiceError(`unit mismatch: item unit is ${item.unit}`, 400);
      }
      const movementUnit = unit || String(item.unit).trim();

      // Policy: update InventoryItem.cost to latest unitCost (overwrite), not weighted average.
      // This affects current valuation: getInventoryValuation uses currentStock * cost (live cost), so after receive, valuation reflects new unitCost for all stock.
      // Weighted-average would be (oldStock*oldCost + quantity*unitCost)/(oldStock+quantity) but is not implemented.

      const totalCost = Math.round(quantity * roundedUnitCost * 100) / 100;

      // Capture before stock/cost for audit
      const beforeStock = Number(item.currentStock) || 0;
      const beforeCost = Number(item.cost) || 0;

      // Atomic stock increase + cost update
      const updated = await InventoryItem.findOneAndUpdate(
        { _id: itemId },
        { $inc: { currentStock: quantity }, $set: { cost: roundedUnitCost, updatedAt: new Date() } },
        { new: true, runValidators: true, session }
      ).lean();
      if (!updated) {
        try { await session.abortTransaction(); } catch {}
        throw new ReceiveServiceError("Inventory item not found", 404);
      }

      // Create exactly one StockMovement IN/Purchase with idempotencyKey
      const StockMovement = getStockMovementModel(conn);
      const movementNotes = notes || `Receive ${quantity} ${movementUnit} @ ${roundedUnitCost}`;
      const [movement] = await StockMovement.create(
        [
          {
            item: itemId,
            type: "IN",
            quantity: quantity,
            reason: "Purchase",
            unit: movementUnit,
            unitCost: roundedUnitCost,
            totalCost: totalCost,
            notes: movementNotes.slice(0, 500),
            createdBy: actorOid,
            refOrderId: null,
            idempotencyKey: idempotencyKey,
            supplier: supplier ? new mongoose.Types.ObjectId(supplier) : null,
          },
        ],
        { session }
      );

      // H7.2 audit trail — PURCHASE_RECEIVED (now valid enum) — inside same transaction
      const afterStock = Number(updated.currentStock) || 0;
      const afterCost = Number(updated.cost) || 0;
      try {
        await createInventoryAudit(
          conn,
          {
            itemId: String(updated._id),
            action: "PURCHASE_RECEIVED",
            actorId: actor ? actor.staffId || null : null,
            actorRole: actor ? actor.role || null : null,
            quantityDelta: quantity,
            beforeStock: beforeStock,
            afterStock: afterStock,
            unit: movementUnit,
            unitCost: roundedUnitCost,
            totalCost: totalCost,
            supplier: supplier || null,
            reason: movementNotes.slice(0, 500),
            correlationId: String(movement._id),
            beforeSnapshot: null,
            afterSnapshot: null,
          },
          { session }
        );
      } catch (auditErr) {
        try { await session.abortTransaction(); } catch {}
        throw auditErr;
      }

      await session.commitTransaction();

      return {
        status: 201,
        data: {
          item: {
            _id: String(updated._id),
            name: updated.name,
            unit: updated.unit,
            currentStock: Number(updated.currentStock) || 0,
            cost: Number(updated.cost) || 0,
          },
          movement: {
            _id: String(movement._id),
            item: String(movement.item),
            type: movement.type,
            quantity: Number(movement.quantity),
            reason: movement.reason,
            unit: movement.unit,
            unitCost: Number(movement.unitCost),
            totalCost: Number(movement.totalCost),
            notes: movement.notes,
            supplier: movement.supplier ? String(movement.supplier) : null,
            idempotencyKey: movement.idempotencyKey,
          },
          previousStock: beforeStock,
          newStock: afterStock,
          costUpdatePolicy: "latest-cost-overwrite",
        },
      };
    } catch (err) {
      if (isReceiveServiceError(err)) {
        try { await session.abortTransaction(); } catch {}
        throw err;
      }
      const hasUnknownLabel =
        (typeof err.hasErrorLabel === "function" && err.hasErrorLabel("UnknownTransactionCommitResult")) ||
        (Array.isArray(err.errorLabels) && err.errorLabels.includes("UnknownTransactionCommitResult"));
      const isBusinessError = err && (err.status === 400 || err.status === 404 || err.status === 409);
      const hasTransientLabel =
        !isBusinessError &&
        !hasUnknownLabel &&
        ((typeof err.hasErrorLabel === "function" && err.hasErrorLabel("TransientTransactionError")) ||
          (Array.isArray(err.errorLabels) && err.errorLabels.includes("TransientTransactionError")) ||
          err.code === 112 ||
          err.code === 251);

      const isIdempotencyDup = isIdempotencyDuplicateKeyError(err);

      if (isIdempotencyDup) {
        // Unique index is the concurrency authority — abort rolls back $inc and audit (same session) so no partial commit
        try {
          await session.abortTransaction();
        } catch {}
        // Re-read winning movement outside aborted transaction
        const StockMovementForDup = getStockMovementModel(conn);
        const existing = await StockMovementForDup.findOne({ idempotencyKey, reason: "Purchase" }).lean();
        if (existing) {
          if (!isSameReceivePayload(existing, { itemId, quantity, unit, roundedUnitCost, supplier })) {
            throw new ReceiveServiceError("Idempotency-Key already used with different payload", 409);
          }
          const InventoryItemForDup = getInventoryItemModel(conn);
          const dupItem = await InventoryItemForDup.findById(itemId).select("_id name unit currentStock cost").lean();
          if (!dupItem) throw new ReceiveServiceError("Inventory item not found", 404);
          return {
            status: 200,
            data: {
              item: {
                _id: String(dupItem._id),
                name: dupItem.name,
                unit: dupItem.unit,
                currentStock: Number(dupItem.currentStock) || 0,
                cost: Number(dupItem.cost) || 0,
              },
              movement: {
                _id: String(existing._id),
                item: String(existing.item),
                type: existing.type,
                quantity: Number(existing.quantity),
                reason: existing.reason,
                unit: existing.unit,
                unitCost: Number(existing.unitCost),
                totalCost: Number(existing.totalCost),
                notes: existing.notes,
                supplier: existing.supplier ? String(existing.supplier) : null,
                idempotencyKey: existing.idempotencyKey,
              },
              previousStock: Number(dupItem.currentStock) - Number(existing.quantity),
              newStock: Number(dupItem.currentStock) || 0,
              costUpdatePolicy: "latest-cost-overwrite",
              replayed: true,
            },
          };
        }
        // No winning movement visible — transient abort before commit or ambiguous commit
        if (hasUnknownLabel) {
          // Never blindly retry UnknownTransactionCommitResult as a new transaction — could double-apply
          throw new ReceiveServiceError(
            "Receipt status unknown — retry with the same Idempotency-Key to confirm. Do not reuse the key for a different payload.",
            503
          );
        }
        if (hasTransientLabel && attempt < 2) {
          try {
            await new Promise((r) => setTimeout(r, 20));
          } catch {}
          // fall through to retry loop (endSession in finally, next attempt)
        } else {
          throw new ReceiveServiceError("Idempotency-Key already used", 409);
        }
      } else {
        // Non-idempotency error — unrelated 11000 (e.g. refOrderId unique) lands here and follows normal handling
        try {
          await session.abortTransaction();
        } catch {}

        if (hasUnknownLabel) {
          // Ambiguous commit outcome — may or may not have committed. Do not claim failure.
          // Best-effort idempotency read: if receipt actually succeeded, replay it instead of 503
          try {
            const StockMovementForUnknown = getStockMovementModel(conn);
            const maybeExisting = await StockMovementForUnknown.findOne({ idempotencyKey, reason: "Purchase" }).lean();
            if (maybeExisting) {
              if (!isSameReceivePayload(maybeExisting, { itemId, quantity, unit, roundedUnitCost, supplier })) {
                throw new ReceiveServiceError("Idempotency-Key already used with different payload", 409);
              }
              const maybeItem = await getInventoryItemModel(conn)
                .findById(itemId)
                .select("_id name unit currentStock cost")
                .lean();
              if (maybeItem) {
                return {
                  status: 200,
                  data: {
                    item: {
                      _id: String(maybeItem._id),
                      name: maybeItem.name,
                      unit: maybeItem.unit,
                      currentStock: Number(maybeItem.currentStock) || 0,
                      cost: Number(maybeItem.cost) || 0,
                    },
                    movement: {
                      _id: String(maybeExisting._id),
                      item: String(maybeExisting.item),
                      type: maybeExisting.type,
                      quantity: Number(maybeExisting.quantity),
                      reason: maybeExisting.reason,
                      unit: maybeExisting.unit,
                      unitCost: Number(maybeExisting.unitCost),
                      totalCost: Number(maybeExisting.totalCost),
                      notes: maybeExisting.notes,
                      supplier: maybeExisting.supplier ? String(maybeExisting.supplier) : null,
                      idempotencyKey: maybeExisting.idempotencyKey,
                    },
                    previousStock: Number(maybeItem.currentStock) - Number(maybeExisting.quantity),
                    newStock: Number(maybeItem.currentStock) || 0,
                    costUpdatePolicy: "latest-cost-overwrite",
                    replayed: true,
                  },
                };
              }
            }
          } catch (maybeErr) {
            if (isReceiveServiceError(maybeErr)) throw maybeErr;
          }
          throw new ReceiveServiceError(
            "Receipt status unknown — retry with the same Idempotency-Key to confirm. Do not reuse the key for a different payload.",
            503
          );
        }

        if (hasTransientLabel && attempt < 2) {
          try {
            await new Promise((r) => setTimeout(r, 20));
          } catch {}
        } else {
          if (isBusinessError) throw err;
          if (isDbError(err)) throw err;
          console.error("[api] inventory receive POST error:", err);
          throw err;
        }
      }
    } finally {
      try {
        await session.endSession();
      } catch {}
    }
  }
  throw new ReceiveServiceError("Failed to receive stock after retry", 500);
}
