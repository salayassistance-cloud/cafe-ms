import mongoose from "mongoose";

// InventoryReservation — Phase 1 hardening.
//
// One document per order. Physical stock stays in InventoryItem.currentStock;
// a non-destructive hold is tracked in InventoryItem.reservedStock.
// Available stock is therefore always `currentStock - reservedStock`.
//
// A reservation never creates stock. A shortage is an explicit blocking state
// (required / available / shortage) and is NOT represented as negative
// currentStock. There is no Manager shortage override: an order that cannot
// cover its required stock cannot be prepared or paid.
//
// Status lifecycle:
//   NO_INVENTORY        order has no recipe-linked inventory requirements
//   RESERVED            all required quantities are physically held
//   INSUFFICIENT_STOCK  shortage exists; preparation and payment are blocked
//   CONSUMING           internal claim while stock is being consumed
//   CONSUMED            physical stock was decremented exactly once
//   RELEASED            hold returned (cancelled/archived order)
//
// Legacy-only values (read compatibility, never written by new code):
//   APPROVAL_REQUIRED   pre-policy shortage awaiting a Manager override
//   APPROVED            pre-policy Manager-approved shortage snapshot

export const RESERVATION_STATUS = [
  "NO_INVENTORY",
  "RESERVED",
  "INSUFFICIENT_STOCK",
  // Read-only legacy values retained so historical reservations still hydrate.
  "APPROVAL_REQUIRED",
  "APPROVED",
  "CONSUMING",
  "CONSUMED",
  "RELEASED",
];

const ReservationItemSchema = new mongoose.Schema(
  {
    inventoryItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryItem",
      required: true,
    },
    unit: { type: String, required: true, trim: true },
    requiredQuantity: { type: Number, required: true, min: 0 },
    reservedQuantity: { type: Number, required: true, min: 0, default: 0 },
    shortageQuantity: { type: Number, required: true, min: 0, default: 0 },
    availableAtDecision: { type: Number, required: true, min: 0, default: 0 },
    consumedQuantity: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

const ApprovalShortageSchema = new mongoose.Schema(
  {
    inventoryItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryItem",
      required: true,
    },
    unit: { type: String, required: true, trim: true },
    requiredQuantity: { type: Number, required: true, min: 0 },
    availableQuantity: { type: Number, required: true, min: 0 },
    shortageQuantity: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const ApprovalSchema = new mongoose.Schema(
  {
    // Identity is always the authenticated MANAGER Staff id, never client text.
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    approvedAt: { type: Date, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    requirementFingerprint: { type: String, required: true },
    shortageFingerprint: { type: String, required: true },
    shortages: { type: [ApprovalShortageSchema], default: [] },
  },
  { _id: false }
);

const VoidItemSchema = new mongoose.Schema(
  {
    inventoryItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryItem",
      required: true,
    },
    unit: { type: String, default: "" },
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// Auditable record of a cancellation/void that happened after physical stock
// had already been consumed at preparation start. Consumed stock is never
// returned to availability.
const ReservationVoidSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
    reason: { type: String, required: true, trim: true, maxlength: 200 },
    phase: {
      type: String,
      enum: ["BEFORE_PREPARATION", "AFTER_PREPARATION"],
      required: true,
    },
    source: {
      type: String,
      enum: ["ORDER", "LINE", "ARCHIVE"],
      default: "ORDER",
    },
    lineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    station: {
      type: String,
      enum: ["KITCHEN", "BARISTA", "HOT_DRINK", "MANAGER"],
      default: null,
    },
    items: { type: [VoidItemSchema], default: [] },
  },
  { _id: false }
);

const InventoryReservationSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      unique: true,
      index: true,
    },
    orderNumber: { type: String, default: null, index: true },
    status: {
      type: String,
      enum: RESERVATION_STATUS,
      required: true,
      index: true,
    },
    items: { type: [ReservationItemSchema], default: [] },
    requirementFingerprint: { type: String, default: null, index: true },
    shortageFingerprint: { type: String, default: null, index: true },
    warnings: { type: [String], default: [] },
    // True when at least one required recipe ingredient could not be validated
    // (unknown/ambiguous unit, missing item, lossy conversion). Such a
    // reservation is written as INSUFFICIENT_STOCK so it blocks preparation and
    // payment; it is never treated as a legitimate NO_INVENTORY.
    unresolved: { type: Boolean, default: false },
    approval: { type: ApprovalSchema, default: null },
    decisionAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
    consumedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
    // PREPARING = consumed at the first preparation start (primary path).
    // PAYMENT   = legacy/fallback consumption when an order reaches PAID
    //             without a preparation consumption.
    consumedTrigger: { type: String, default: null },
    releasedAt: { type: Date, default: null },
    releaseReason: { type: String, default: null },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, default: null },
    voidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
    voids: { type: [ReservationVoidSchema], default: [] },
  },
  { timestamps: true, strict: true }
);

// Shortage diagnostics: blocked orders, oldest first.
InventoryReservationSchema.index({ status: 1, createdAt: 1 });
// Stale-hold diagnostics.
InventoryReservationSchema.index({ status: 1, updatedAt: -1 });

export function getInventoryReservationModel(connection) {
  return (
    connection.models.InventoryReservation ||
    connection.model("InventoryReservation", InventoryReservationSchema, "inventoryreservations")
  );
}

export { InventoryReservationSchema, ReservationItemSchema, ApprovalSchema, ReservationVoidSchema };
