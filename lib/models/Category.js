import mongoose from "mongoose";

// Category model for the Hotel Management System POS. Active categories drive the menu and
// the Waiter UI tabs; `type` splits the KDS into Kitchen vs Barista scopes.

const LocalizedString = new mongoose.Schema(
  {
    am: { type: String, default: "" },
    en: { type: String, default: "" },
    om: { type: String, default: "" },
  },
  { _id: false }
);

const CategorySchema = new mongoose.Schema(
  {
    // Unified category name — spec says String, but existing DB holds LocalizedString {am,en,om} or plain String.
    // Using Mixed to accept both and satisfy "Unified Database" requirement (same collection `categories` as Bono).
    name: { type: mongoose.Schema.Types.Mixed, required: true },
    slug: { type: String, required: true, unique: true, index: true },
    type: { type: String, enum: ["FOOD", "DRINK"], default: "FOOD" },
    targetStation: { type: String, enum: ["KITCHEN", "BARISTA"], default: "KITCHEN" },
    isActive: { type: Boolean, default: true },
    // Legacy/UI helpers for ordering
    order: { type: Number, default: 0 },
    displayOrder: { type: Number, default: 0 },
    icon: { type: String, default: "" },
  },
  // Phase 3 hardening: strict enabled (was false) after verifying 0 docs missing canonical order/targetStation.
  { timestamps: true, strict: true }
);

CategorySchema.pre("validate", function () {
  if (this.targetStation && !this.type) this.type = this.targetStation === "BARISTA" ? "DRINK" : "FOOD";
  if (this.type && !this.targetStation) this.targetStation = this.type === "DRINK" ? "BARISTA" : "KITCHEN";
});

export function getCategoryModel(connection) {
  return (
    connection.models.Category ||
    connection.model("Category", CategorySchema, "categories")
  );
}

export { CategorySchema };
