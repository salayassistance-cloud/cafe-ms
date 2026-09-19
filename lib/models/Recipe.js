import mongoose from "mongoose";

// Recipe model — Phase C database foundation.
// Separate collection `recipes`; does NOT modify MenuItem.

const RecipeIngredientSchema = new mongoose.Schema(
  {
    inventoryItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryItem",
      required: true,
    },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const RecipeSchema = new mongoose.Schema(
  {
    menuItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MenuItem",
      required: true,
      unique: true,
      index: true,
    },
    ingredients: { type: [RecipeIngredientSchema], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, strict: true }
);

// Index for ingredient lookup
RecipeSchema.index({ "ingredients.inventoryItemId": 1 });

export function getRecipeModel(connection) {
  return (
    connection.models.Recipe ||
    connection.model("Recipe", RecipeSchema, "recipes")
  );
}

export { RecipeSchema, RecipeIngredientSchema };
