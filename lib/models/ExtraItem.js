import mongoose from "mongoose";

// ExtraItem model — a small, sellable wrapper around an existing canonical
// InventoryItem. It intentionally stores no recipe: ordering an Extra Item
// deducts one linked stock unit per selected quantity through the same
// reservation/consumption lifecycle as every other inventory movement.
//
// `sellingPrice` is the price charged to the guest. It is deliberately separate
// from `InventoryItem.cost` (the stock unit cost used for cost snapshots).

const ExtraItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    category: { type: String, required: true, trim: true, default: "Extra Items" },
    sellingPrice: { type: Number, required: true, min: 0, max: 100000 },
    inventoryItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryItem",
      required: true,
      index: true,
    },
    isAvailable: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, strict: true }
);

ExtraItemSchema.index({ isAvailable: 1, name: 1 });

export function getExtraItemModel(connection) {
  return (
    connection.models.ExtraItem ||
    connection.model("ExtraItem", ExtraItemSchema, "extraitems")
  );
}

export { ExtraItemSchema };
