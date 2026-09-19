import mongoose from "mongoose";

// StockMovement model — Phase C database foundation.
// Audit trail for inventory stock changes. Isolated collection `stockmovements`.

const StockMovementSchema = new mongoose.Schema(
  {
    item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryItem",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["IN", "OUT", "ADJUSTMENT"],
      required: true,
    },
    quantity: { type: Number, required: true },
    reason: {
      type: String,
      enum: ["Purchase", "SaleDeduction", "Waste", "Correction", "Initial"],
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
    refOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    unit: { type: String, default: null },
    unitCost: { type: Number, default: null },
    totalCost: { type: Number, default: null },
    notes: { type: String, default: "" },
  },
  { timestamps: true, strict: true }
);

// Index per spec: item + timestamp desc (createdAt)
StockMovementSchema.index({ item: 1, createdAt: -1 });

// Idempotency hardening — DB-level protection for SaleDeduction duplicates
StockMovementSchema.index(
  { refOrderId: 1, reason: 1 },
  { unique: true, partialFilterExpression: { refOrderId: { $type: "objectId" } } }
);

export function getStockMovementModel(connection) {
  return (
    connection.models.StockMovement ||
    connection.model("StockMovement", StockMovementSchema, "stockmovements")
  );
}

export { StockMovementSchema };
