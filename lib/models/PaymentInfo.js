import mongoose from "mongoose";

// PaymentInfo model — bank / transfer details shown to customers on the
// public /menu "Pay" modal and managed from /manager/menu-crud.
// bankName, ownerName, accountNumber, isActive.

const PaymentInfoSchema = new mongoose.Schema(
  {
    bankName: { type: String, required: true, trim: true },
    ownerName: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, strict: true }
);

export function getPaymentInfoModel(connection) {
  return (
    connection.models.PaymentInfo ||
    connection.model("PaymentInfo", PaymentInfoSchema, "paymentinfos")
  );
}

export { PaymentInfoSchema };
