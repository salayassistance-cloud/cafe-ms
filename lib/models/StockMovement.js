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
    idempotencyKey: {
      type: String,
      default: null,
    },
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },
    unit: { type: String, default: null },
    unitCost: { type: Number, default: null },
    totalCost: { type: Number, default: null },
    // Phase 1.1: a SaleDeduction recorded at preparation start may later be
    // voided by a cancelled order. The stock is NOT decremented again; for a
    // whole-order cancellation the reason is reclassified to Waste and these
    // fields preserve the audit reason. Additive and nullable.
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, default: null, trim: true },
    voidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
    notes: { type: String, default: "" },
  },
  { timestamps: true, strict: true }
);

// Index per spec: item + timestamp desc (createdAt)
StockMovementSchema.index({ item: 1, createdAt: -1 });

// H7.5: reason + timestamp for consumption/waste/food-cost reporting (reason equality + createdAt range/sort)
StockMovementSchema.index({ reason: 1, createdAt: -1 });

// Idempotency hardening — DB-level protection for SaleDeduction duplicates.
// SaleDeduction writes one movement per ingredient, so the uniqueness unit is
// (order, reason, item). The previous (order, reason) index rejected every
// multi-ingredient order. Deployment must replace the old index — see the
// Phase 1 inventory report (no migration is run by application code here).
StockMovementSchema.index(
  { refOrderId: 1, reason: 1, item: 1 },
  { unique: true, partialFilterExpression: { refOrderId: { $type: "objectId" } } }
);

// H2.1: idempotency for Purchase receiving — global unique per idempotencyKey (String UUID), partial so legacy null not indexed
StockMovementSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);

export function getStockMovementModel(connection) {
  return (
    connection.models.StockMovement ||
    connection.model("StockMovement", StockMovementSchema, "stockmovements")
  );
}

export { StockMovementSchema };
