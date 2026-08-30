import mongoose from "mongoose";

// BrandConfig model — single configuration document that drives the public
// /menu header (cafe name + logo). Managed from /manager/menu-crud.
// name: String, logoPath: String (URL, /uploads path, or Base64 data URI).

const BrandConfigSchema = new mongoose.Schema(
  {
    name: { type: String, default: "I HOPE CAFE" },
    logoPath: { type: String, default: "" },
  },
  { timestamps: true, strict: true }
);

export function getBrandConfigModel(connection) {
  return (
    connection.models.BrandConfig ||
    connection.model("BrandConfig", BrandConfigSchema, "brandconfigs")
  );
}

export { BrandConfigSchema };
