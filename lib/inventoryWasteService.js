import mongoose from "mongoose";
import { getInventoryItemModel } from "@/lib/models/InventoryItem";
import { getStockMovementModel } from "@/lib/models/StockMovement";

export async function createWasteMovement(conn, { itemId, quantity, notes, actorId }) {
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

  // H7.1 concurrency fix: bounded retry for TransientTransactionError only.
  // UnknownTransactionCommitResult is NOT retried to avoid duplicate StockMovement.
  // Verified driver (mongoose 9.9.3 / MongoDB driver 6.x): errors surface via err.hasErrorLabel(label) and err.errorLabels array, codes 112/251.
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await conn.startSession();
    try {
      session.startTransaction();

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
      if (hasTransientLabel && !hasUnknownLabel && attempt === 0) {
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
