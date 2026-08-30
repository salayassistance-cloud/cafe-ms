import mongoose from "mongoose";

// External Item Request model — waiter-requested items that are NOT part of the
// canonical Menu catalog (e.g. special/off-menu requests). These need Manager
// review and are surfaced separately (tagged EXTERNAL ITEM) in Manager Reports.
//
// This is intentionally a SEPARATE collection from `orders` so we never mix
// pending/non-menu requests into the kitchen/barista workflow or the normal
// menu item statistics. The waiter identity is derived server-side from the
// authenticated session (never trusted from the client).

const ExternalItemRequestSchema = new mongoose.Schema(
  {
    // Auditable waiter identity — FK to Staff.id (preferred) + cached name.
    waiterId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    waiterName: { type: String, default: "Waiter" },
    waiterNumber: { type: Number, default: null, index: true },
    // Table/order reference at the time the request was raised (if available).
    tableNumber: { type: Number, default: null, index: true },
    // Requested item details
    itemName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1, max: 99 },
    type: { type: String, enum: ["FOOD", "DRINK"], default: "FOOD", index: true },
    price: { type: Number, required: true, min: 0 },
    // Review status — PENDING until a Manager acts. Kept simple per spec.
    status: {
      type: String,
      enum: ["PENDING", "REVIEWED", "REJECTED"],
      default: "PENDING",
      index: true,
    },
  },
  { timestamps: true }
);

ExternalItemRequestSchema.index({ createdAt: -1 });

export function getExternalItemRequestModel(connection) {
  return (
    connection.models.ExternalItemRequest ||
    connection.model("ExternalItemRequest", ExternalItemRequestSchema, "externalitemrequests")
  );
}

const ExternalItemRequest =
  mongoose.models.ExternalItemRequest ||
  mongoose.model("ExternalItemRequest", ExternalItemRequestSchema, "externalitemrequests");

export default ExternalItemRequest;
export { ExternalItemRequestSchema };
