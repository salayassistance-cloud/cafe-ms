import mongoose from "mongoose";
import { STOCK_GROUP_VALUES } from "../inventoryCategories.js";

// InventoryItem model — Phase C database foundation (independent of MenuItem/Order).
// Isolated collection `inventoryitems`; no mutation of existing schemas.

const InventoryItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    // Four physically separate stock areas. Optional for legacy items: an
    // unassigned item is never guessed into a group and is never backfilled.
    // No dedicated index: it is a low-cardinality filter and the list query
    // is already bounded, so this change adds no new deployed index.
    stockGroup: {
      type: String,
      enum: STOCK_GROUP_VALUES,
      default: null,
    },
    unit: { type: String, required: true, trim: true },
    currentStock: { type: Number, default: 0, min: 0 },
    // Phase 1: physical stock held by live orders. Available = currentStock - reservedStock.
    // Never used to represent a shortage (approved shortages live on InventoryReservation).
    reservedStock: { type: Number, default: 0, min: 0 },
    minimumStock: { type: Number, default: 0, min: 0 },
    cost: { type: Number, default: 0, min: 0 },
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },
    status: {
      type: String,
      enum: ["In Stock", "Low Stock", "Out Of Stock"],
      default: "In Stock",
    },
    // OBS-3 coordination token: incremented by every committed Recipe write
    // that references this item and by every committed unit change. It is NOT
    // the authoritative unit (that stays `unit`) and is never read for
    // decisions. Declared explicitly because `strict: true` strips undeclared
    // `$inc` paths. No index, no backfill: legacy docs start at 0 and `$inc`
    // creates the field on first use.
    unitRevision: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, strict: true }
);

// Indexes per spec
InventoryItemSchema.index({ category: 1, status: 1 });
InventoryItemSchema.index({ supplier: 1, status: 1 });

export function getInventoryItemModel(connection) {
  return (
    connection.models.InventoryItem ||
    connection.model("InventoryItem", InventoryItemSchema, "inventoryitems")
  );
}

export { InventoryItemSchema };
