import mongoose from "mongoose";

// Supplier model — Phase C database foundation. Isolated collection `suppliers`.

const SupplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    contact: { type: String, default: "" },
    address: { type: String, default: "" },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
  },
  { timestamps: true, strict: true }
);

export function getSupplierModel(connection) {
  return (
    connection.models.Supplier ||
    connection.model("Supplier", SupplierSchema, "suppliers")
  );
}

export { SupplierSchema };
