import mongoose from "mongoose";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { getStockMovementModel } from "@/lib/models/StockMovement";
import { createInventoryAudit } from "@/lib/inventoryAuditService";

export async function createWasteMovement(conn, { itemId, quantity, notes, actorId, actorRole }) {
  const sid = String(itemId || "").trim();
  if (!sid || !mongoose.isValidObjectId(sid)) {
    const err = new Error("Invalid itemId: must be valid ObjectId");
    err.status = 400;
    throw err;
  }
  // H7.1: strict finite numeric >0 — reject arrays/objects/booleans that Number() would coerce
  if (Array.isArray(quantity) || (quantity != null && typeof quantity === "object") || typeof quantity === "boolean") {
    const err = new Error("quantity must be number > 0");
    err.status = 400;
    throw err;
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    const err = new Error("quantity must be number > 0");
    err.status = 400;
    throw err;
  }

  const InventoryItem = getInventoryItemModel(conn);
  const item = await InventoryItem.findById(sid).select("_id name status").lean();
  if (!item) {
    const err = new Error("Inventory item not found");
    err.status = 404;
    throw err;
  }
  if (item.status && String(item.status).toLowerCase() === "inactive") {
    const err = new Error("Cannot waste inactive item");
    err.status = 400;
    throw err;
  }

  let actorOid = null;
  if (actorId && mongoose.isValidObjectId(String(actorId))) {
    actorOid = new mongoose.Types.ObjectId(String(actorId));
  }
  const normalizedRole = actorRole ? String(actorRole).trim().toUpperCase() : null;
  const allowedRoles = ["WAITER", "KITCHEN", "BARISTA", "MANAGER"];
  const auditRole = allowedRoles.includes(normalizedRole) ? normalizedRole : null;

  // H7.1 concurrency fix: bounded retry for TransientTransactionError only (max 2 retries).
  // UnknownTransactionCommitResult is NOT retried to avoid duplicate StockMovement.
  // Verified driver (mongoose 9.9.3 / MongoDB driver 6.x): errors surface via err.hasErrorLabel(label) and err.errorLabels array, codes 112/251.
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = await conn.startSession();
    try {
      session.startTransaction();

      // Capture before snapshot inside transaction for audit (consistent with atomic update snapshot)
      const beforeDocForAudit = await InventoryItem.findById(sid).session(session).select("currentStock").lean();
      const beforeStockAudit = beforeDocForAudit ? Number(beforeDocForAudit.currentStock) : null;

      // Atomic conditional decrement: only succeeds when sufficient stock exists.
      // Prevents race where concurrent waste requests would drive currentStock below zero.
      // Prior read is not sufficient protection; this filter is the source of truth.
      const updateResult = await InventoryItem.updateOne(
        { _id: sid, currentStock: { $gte: qty } },
        { $inc: { currentStock: -qty } },
        { session }
      );
      const modified = updateResult.modifiedCount ?? updateResult.nModified ?? 0;
      if (modified === 0) {
        // Do not rely on stale transaction snapshot — abort then read committed state outside session
        try {
          await session.abortTransaction();
        } catch {}
        const fresh = await InventoryItem.findById(sid).select("_id status currentStock").lean();
        if (!fresh) {
          const err = new Error("Inventory item not found");
          err.status = 404;
          throw err;
        }
        if (fresh.status && String(fresh.status).toLowerCase() === "inactive") {
          const err = new Error("Cannot waste inactive item");
          err.status = 400;
          throw err;
        }
        const avail = Number(fresh.currentStock);
        const availSafe = Number.isFinite(avail) ? avail : 0;
        if (availSafe < qty) {
          const err = new Error(`Insufficient stock: available ${availSafe}, requested ${qty}`);
          err.status = 400;
          throw err;
        }
        const err = new Error("Failed to decrement stock");
        err.status = 409;
        throw err;
      }

      const StockMovement = getStockMovementModel(conn);
      const [created] = await StockMovement.create(
        [
          {
            item: sid,
            type: "OUT",
            quantity: qty,
            reason: "Waste",
            notes: String(notes || "").trim().slice(0, 500),
            createdBy: actorOid,
          },
        ],
        { session }
      );

      // H7.2 audit trail — inside same transaction, do not claim success if audit fails
      // Use shared audit service for server-side validation/normalization (actor derived from session, no secrets)
      const afterStockAudit = beforeStockAudit != null && Number.isFinite(beforeStockAudit) ? beforeStockAudit - qty : null;
      const auditReason = String(notes || "").trim().slice(0, 500);
      await createInventoryAudit(
        conn,
        {
          itemId: sid,
          action: "WASTE",
          actorId: actorOid ? String(actorOid) : null,
          actorRole: auditRole,
          quantityDelta: qty,
          beforeStock: Number.isFinite(beforeStockAudit) ? beforeStockAudit : null,
          afterStock: Number.isFinite(afterStockAudit) ? afterStockAudit : null,
          reason: auditReason,
          correlationId: String(created._id),
        },
        { session }
      );

      await session.commitTransaction();

      return {
        itemId: String(created.item),
        quantity: Number(created.quantity),
        reason: "Waste",
      };
    } catch (err) {
      const isBusinessError = err && (err.status === 400 || err.status === 404 || err.status === 409);
      const hasTransientLabel =
        !isBusinessError &&
        ((typeof err.hasErrorLabel === "function" && err.hasErrorLabel("TransientTransactionError")) ||
          (Array.isArray(err.errorLabels) && err.errorLabels.includes("TransientTransactionError")) ||
          err.code === 112 ||
          err.code === 251);
      const hasUnknownLabel =
        (typeof err.hasErrorLabel === "function" && err.hasErrorLabel("UnknownTransactionCommitResult")) ||
        (Array.isArray(err.errorLabels) && err.errorLabels.includes("UnknownTransactionCommitResult"));

      try {
        await session.abortTransaction();
      } catch {}

      // Safe bounded retry: TransientTransactionError guarantees not committed; Unknown is NOT retried to avoid duplicate
      if (hasTransientLabel && !hasUnknownLabel && attempt < 2) {
        // Brief backoff to let winning transaction commit before retry
        try { await new Promise((r) => setTimeout(r, 20)); } catch {}
        // retry with new session — finally will end this session before next attempt
      } else {
        throw err;
      }
    } finally {
      try {
        await session.endSession();
      } catch {}
    }
  }
  // Should never reach — either returned or thrown; fallback for exhausted retry
  const retryErr = new Error("Failed to decrement stock");
  retryErr.status = 409;
  throw retryErr;
}
