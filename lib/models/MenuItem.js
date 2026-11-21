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
    categoryType: { type: String, enum: ["FOOD", "DRINK", "HOT_DRINK"], default: "FOOD" },
    // Prep station this item belongs to. FOOD -> KITCHEN, DRINK -> BARISTA,
    // HOT_DRINK -> HOT_DRINK (JEBENA BUNA). Required for new catalog entries;
    // legacy docs without it are resolved at order-snapshot time from
    // `categoryType` (see lib/orderService).
    station: {
      type: String,
      enum: ["KITCHEN", "BARISTA", "HOT_DRINK"],
      required: true,
    },
    targetStation: {
      type: String,
      enum: ["KITCHEN", "BARISTA", "HOT_DRINK"],
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
    // H1: explicit inventory policy. Only TRACKED and UNTRACKED are valid for
    // new writes; EXTERNAL was rejected and is intentionally absent from the
    // enum. A legacy document with no value resolves to UNKNOWN in
    // lib/inventoryPolicy.js and is never silently classified. Mongoose does
    // not validate on read, so a historical EXTERNAL value remains readable.
    inventoryPolicy: {
      type: String,
      enum: {
        values: ["TRACKED", "UNTRACKED"],
        message: "inventoryPolicy must be TRACKED or UNTRACKED",
      },
      default: null,
      // H1: every NEW catalog row must state a policy. Legacy rows loaded from
      // the database ($isNew false) are never retroactively required to have
      // one. NOTE: use $isNew, not isNew — this schema has its own isNew field
      // (the "mark as new" catalog badge), which shadows Document#isNew.
      required: function () {
        return this.$isNew === true;
      },
    },
    // Phase 2.1: shared serialization token for MenuItem classification vs
    // order creation/edit-addition. New documents start at 0; a legacy
    // document with the field absent is treated as 0 by the read helpers.
    // No migration or backfill — this field is never written merely to
    // initialize legacy rows.
    policyVersion: { type: Number, default: 0, min: 0 },
    // H1 soft deletion: catalog rows are retained so Recipe and historical
    // order references survive. Every active read path must exclude
    // isDeleted:true. There is no TTL or automatic purge.
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
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
