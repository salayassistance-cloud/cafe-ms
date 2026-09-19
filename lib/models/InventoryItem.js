import mongoose from "mongoose";

// InventoryItem model — Phase C database foundation (independent of MenuItem/Order).
// Isolated collection `inventoryitems`; no mutation of existing schemas.

const InventoryItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    unit: { type: String, required: true, trim: true },
    currentStock: { type: Number, default: 0, min: 0 },
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
