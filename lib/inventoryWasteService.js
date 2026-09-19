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

  const session = await conn.startSession();
  try {
    session.startTransaction();

    await InventoryItem.updateOne(
      { _id: sid },
      { $inc: { currentStock: -qty } },
      { session }
    );

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
    try {
      await session.abortTransaction();
    } catch {}
    throw err;
  } finally {
    try {
      await session.endSession();
    } catch {}
  }
}
