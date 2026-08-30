import mongoose from "mongoose";

// MenuItem model for the Hotel Management System POS. Prices are snapshotted onto each Order
// line at creation time, so this collection is the catalog of record.

const LocalizedString = new mongoose.Schema(
  {
    am: { type: String, default: "" },
    en: { type: String, default: "" },
    om: { type: String, default: "" },
  },
  { _id: false }
);

const MenuItemSchema = new mongoose.Schema(
  {
    // Trilingual names: { am, en, om } — matches image_b13169.png spec (English, Amharic, Afaan Oromoo)
    name: { type: LocalizedString, required: true },
    // Trilingual descriptions
    description: { type: LocalizedString, default: () => ({ am: "", en: "", om: "" }) },
    price: { type: Number, required: true, min: 0 },
    // Category reference — unified Bono+Manager schema uses `category` (Bono) and `categoryId` (legacy) as aliases.
    // Both resolve to the same ObjectId in `categories` collection via shared MONGODB_URI.
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
    },
    categoryType: { type: String, enum: ["FOOD", "DRINK"], default: "FOOD" },
    // Prep station this item belongs to. FOOD -> KITCHEN, DRINK -> BARISTA.
    // Required for new catalog entries; legacy docs without it are resolved at
    // order-snapshot time from `categoryType` (see lib/orderService).
    station: {
      type: String,
      enum: ["KITCHEN", "BARISTA"],
      required: true,
    },
    targetStation: {
      type: String,
      enum: ["KITCHEN", "BARISTA"],
      default: "KITCHEN",
    },
    imageUrl: { type: String, default: "" },
    // Alias for legacy `image` field (Bono store)
    image: { type: String, default: "" },
    // Core booleans from image_b13169.png spec
    isSpecial: { type: Boolean, default: false },
    isNew: { type: Boolean, default: false },
    // Legacy alias for isNew
    isItemNew: { type: Boolean, default: false },
    isPopular: { type: Boolean, default: false },
    isAvailable: { type: Boolean, default: true },
    // Fasting flags — Ethiopian fasting (Tsom) support
    isFasting: { type: Boolean, default: false },
    isNonFasting: { type: Boolean, default: true },
    // Legacy inStock alias
    inStock: { type: Boolean, default: true },
  },
  // Phase 3 hardening: strict enabled (was false) after canonical migration verified (2026-08-24).
  // Legacy aliases (categoryId, station, image, isItemNew, isPopular, inStock) retained as defined fields
  // for read-compat; no unknown fields will be persisted.
  { timestamps: true, strict: true, suppressReservedKeysWarning: true }
);

// Canonical compound index for "available items in a category" (Phase 3: legacy categoryId index removed after migration).
MenuItemSchema.index({ category: 1, isAvailable: 1 });

// Ensure category/categoryId alias sync before validate (Mongoose 9 compatible — no `next` arg needed, sync hook)
MenuItemSchema.pre("validate", function () {
  if (this.category && !this.categoryId) this.categoryId = this.category;
  if (this.categoryId && !this.category) this.category = this.categoryId;
  // Sync isNew <-> isItemNew
  if (this.isNew !== undefined) this.isItemNew = this.isNew;
  else if (this.isItemNew !== undefined) this.isNew = this.isItemNew;
  // Sync image alias
  if (this.imageUrl && !this.image) this.image = this.imageUrl;
  if (this.image && !this.imageUrl) this.imageUrl = this.image;
  // Sync targetStation <-> station
  if (this.targetStation && !this.station) this.station = this.targetStation;
  if (this.station && !this.targetStation) this.targetStation = this.station;
});

export function getMenuItemModel(connection) {
  return (
    connection.models.MenuItem ||
    connection.model("MenuItem", MenuItemSchema, "menuitems")
  );
}

export { MenuItemSchema };
