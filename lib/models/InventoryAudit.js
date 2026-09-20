import mongoose from "mongoose";

// InventoryAudit model — H7.2 audit trail for inventory-changing actions.
// Isolated collection `inventoryaudits`; no mutation of existing schemas.
// Traceable: who (actorId/role), what (action), when (timestamps), which record (item), delta/reason.

const AUDIT_ACTIONS = ["ITEM_CREATED", "ITEM_UPDATED", "WASTE"];

const InventoryAuditSchema = new mongoose.Schema(
  {
    item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryItem",
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: AUDIT_ACTIONS,
      required: true,
      index: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
      index: true,
    },
    actorRole: {
      type: String,
      enum: ["WAITER", "KITCHEN", "BARISTA", "MANAGER"],
      default: null,
    },
    quantityDelta: { type: Number, default: null },
    beforeStock: { type: Number, default: null },
    afterStock: { type: Number, default: null },
    // Concise reason/reference when workflow provides one (waste notes, update changed fields)
    reason: { type: String, default: "" },
    // Correlation/reference id if system already supports one (e.g., StockMovement _id for WASTE)
    correlationId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    // Optional before/after snapshots for ITEM_UPDATED (validated server-side, no secrets)
    beforeSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    afterSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, strict: true }
);

// Query patterns: item + time, actor + time, action + time
InventoryAuditSchema.index({ item: 1, createdAt: -1 });
InventoryAuditSchema.index({ actorId: 1, createdAt: -1 });
InventoryAuditSchema.index({ action: 1, createdAt: -1 });
InventoryAuditSchema.index({ correlationId: 1 });

export function getInventoryAuditModel(connection) {
  return (
    connection.models.InventoryAudit ||
    connection.model("InventoryAudit", InventoryAuditSchema, "inventoryaudits")
  );
}

export { InventoryAuditSchema, AUDIT_ACTIONS };
