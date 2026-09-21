import mongoose from "mongoose";

// Unified Order model — the single source of truth for the HOTEL MANAGEMENT SYSTEM POS,
// shared by the Waiter UI, KDS, Manager Dashboard and analytics/reporting.
//
// Pristine order lifecycle (see lib/orderService state machine):
//   PENDING -> PREPARING -> READY -> SERVED -> PAID
// CANCELLED is an additional terminal state (manager void of the whole ticket).
// ARCHIVED is a KDS-only dismiss state: the row is kept in the database (sales
// history intact) but leaves the live ACTIVE query immediately.

const STATUS = [
  "PENDING",
  "PREPARING",
  "READY",
  "SERVED",
  "PAYMENT_PENDING",
  "PAID",
  "CANCELLED",
  "ARCHIVED",
];

const ITEM_TYPE = ["FOOD", "DRINK"];

const OrderComponentSchema = new mongoose.Schema(
  {
    // Stable per-component identity
    componentId: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId(), index: true },
    // Explicit two types: NOTE (informational) vs PRICED_COMPONENT (billable)
    kind: { type: String, enum: ["NOTE", "PRICED_COMPONENT"], required: true },
    // Type A: Ingredient / Instruction Note — informational only
    note: { type: String, trim: true, default: null }, // max 500, only for NOTE
    // Type B: Priced Component — waiter enters name, quantity, unit selling price
    name: { type: String, trim: true, default: null }, // required for PRICED
    quantity: { type: Number, min: 1, max: 99, default: null }, // for PRICED
    unitPrice: { type: Number, min: 0, default: null }, // selling price per unit, for PRICED
    lineSum: { type: Number, min: 0, default: null }, // quantity * unitPrice, server-calculated
    // Inventory link (optional, only for PRICED). Manual selling price is NOT cost.
    inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", default: null },
    stockQuantity: { type: Number, min: 0, default: null }, // consumption per component unit
    stockUnit: { type: String, trim: true, default: null },
    // Cost snapshot from inventory at order time — null if no valid link
    costSnapshot: { type: Number, min: 0, default: null }, // inventory cost per stockUnit
    totalCost: { type: Number, min: 0, default: null }, // stockQuantity * quantity * costSnapshot
  },
  { _id: false }
);

const OrderItemSchema = new mongoose.Schema(
  {
    // Stable per-line identity for targeted atomic updates (arrayFilters). Keep _id:false for backward compat;
    // lineId is the primary key for item-level cancellation. Generated on order creation.
    lineId: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId(), index: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, max: 99 },
    type: { type: String, enum: ITEM_TYPE, default: "FOOD" },
    // Marks manually-entered items added by a waiter (e.g. retail / external
    // sales) that are not part of the kitchen/barista catalog.
    // Kept for legacy order compatibility (Option B); new orders use components instead of isExternal lines.
    isExternal: { type: Boolean, default: false },
    // Snapshot of canonical MenuItem id when available — allows server-authoritative price/type resolution
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem", default: null },
    // Item-level cancellation metadata — additive, nullable for backward compat.
    // cancelled=true means line is void; original price/qty/type preserved.
    cancelled: { type: Boolean, default: false, index: true },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    cancelledStation: { type: String, enum: ["KITCHEN", "BARISTA", "MANAGER"], default: null },
    cancelReason: { type: String, default: null, trim: true },
    // Components attached to this specific menu item — not standalone orders
    components: { type: [OrderComponentSchema], default: [] },
  },
  { _id: false }
);

// Nested waiter identity captured at order-creation time. Additive: legacy
// orders without this field hydrate as null and all UI falls back to the
// top-level `waiterNumber`/`waiterName`.
const WaiterInfoSchema = new mongoose.Schema(
  {
    waiterId: { type: String, default: null },
    waiterNumber: { type: Number, required: false },
    shiftId: { type: String, default: 'SHIFT-DEFAULT' },
    deviceId: { type: String, default: 'DEVICE-UNKNOWN' },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, index: true },
    tableNumber: { type: Number, required: true, index: true },
    waiterName: { type: String, default: "Waiter" },
    // Auditable waiter identity — FK to Staff.id (preferred) + cached name.
    // waiterNumber kept for backward compat with legacy 1-10 grid.
    waiterId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    waiterNumber: { type: Number, default: null, index: true },
    waiterInfo: { type: WaiterInfoSchema, default: null },
    // Who marked READY in each prep station — auditable, nullable
    kitchenStaffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    baristaStaffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    items: { type: [OrderItemSchema], default: [] },
    // Manual / external sales (e.g. retail items entered by a waiter) that are
    // not part of the kitchen/barista workflow but still count toward revenue.
    isExternal: { type: Boolean, default: false, index: true },
    // LIFECYCLE: PENDING -> PREPARING -> READY -> SERVED -> PAID
    status: {
      type: String,
      enum: STATUS,
      default: "PENDING",
      index: true,
    },
    totalAmount: { type: Number, required: true, min: 0 },
    paymentMethod: {
      type: String,
      // TRANSFER is canonical; TELEBIRR preserved for historical orders (display as Transfer)
      enum: ["CASH", "TRANSFER", "TELEBIRR", "NONE"],
      default: "NONE",
    },
    // Transfer payment account — snapshot preserved for historical correctness.
    // Cash never requires account; Transfer requires active account validated server-side.
    paymentAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentInfo", default: null, index: true },
    paymentAccountSnapshot: {
      bankName: { type: String, default: null },
      ownerName: { type: String, default: null },
      accountNumber: { type: String, default: null },
    },
    // Payment verification workflow: waiter submits (PAYMENT_PENDING), cashier verifies (PAID)
    paymentSubmittedAt: { type: Date, default: null },
    paymentSubmittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    paymentVerifiedAt: { type: Date, default: null },
    paymentVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    paymentRejectedAt: { type: Date, default: null },
    paymentRejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
    paymentRejectionReason: { type: String, default: null },
    // Lifecycle transition timestamps, recorded by lib/orderService on every
    // status change. Driven the analytics "AVG FULFILLMENT SPEED" KPI. All
    // default to null so legacy / bypassed orders simply fall back to
    // createdAt / updatedAt (see lib/analytics.js).
    preparingAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    servedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    // Per-station preparation tracking — minimal safe schema change for independent Kitchen/Barista lifecycles.
    // Allows Kitchen READY without prematurely marking Barista READY for mixed orders.
    // All nullable for backward compat; legacy orders without these fields fall back to preparingAt/readyAt.
    kitchenStatus: { type: String, enum: STATUS, default: null, index: true },
    baristaStatus: { type: String, enum: STATUS, default: null, index: true },
    kitchenPreparingAt: { type: Date, default: null },
    kitchenReadyAt: { type: Date, default: null },
    baristaPreparingAt: { type: Date, default: null },
    baristaReadyAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Index on createdAt for fast interval reporting (no TTL — orders are archived).
OrderSchema.index({ createdAt: 1 });
// KDS / Barista / Waiter poll the live board as
// { status: { $in: [PENDING, PREPARING, READY] } } sorted by createdAt desc —
// a compound index serves the filter + sort without a collection scan.
OrderSchema.index({ status: 1, createdAt: -1 });
// Board scoping by prep type (FOOD=kitchen, DRINK=barista) adds items.type to
// the same filter; compound index keeps that path indexed too.
OrderSchema.index({ status: 1, "items.type": 1, createdAt: -1 });
// Manager Reports group by waiter — the top-level field is already indexed;
// this compound covers the "range + status + waiter" report shape.
OrderSchema.index({ waiterNumber: 1, createdAt: -1 });
OrderSchema.index({ waiterId: 1, createdAt: -1 });
OrderSchema.index({ waiterName: 1, status: 1 });
OrderSchema.index({ kitchenStaffId: 1, createdAt: -1 });
OrderSchema.index({ baristaStaffId: 1, createdAt: -1 });

export function getOrderModel(connection) {
  return (
    connection.models.Order ||
    connection.model("Order", OrderSchema, "orders")
  );
}

// Canonical default model — strictly bound to the `orders` collection (the
// single source of truth). Prefer getOrderModel(conn) inside route handlers so
// the model binds to the dedicated orders connection; this default export is
// for scripts / single-connection use.
const Order =
  mongoose.models.Order || mongoose.model("Order", OrderSchema, "orders");
export default Order;

export { OrderSchema, STATUS, ITEM_TYPE };
