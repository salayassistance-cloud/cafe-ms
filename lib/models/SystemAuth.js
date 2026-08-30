// Unified system settings + active waiter session model (singleton document).
// Phase 6.5 CANONICAL: Staff collection is the source of truth for all
// individual PINs (Staff.pinHash). SystemAuth role PIN fields
// (waiterPin/kitchenPin/baristaPin/managerPin) are retained ONLY for
// legacy compatibility / emergency migration and MUST NOT be used as the
// canonical credential for new authentication logic. The remaining
// authoritative responsibility of SystemAuth is activeWaiters (locked
// waiterNumber → deviceSessionId + sessionVersion for invalidation after
// manager reset). Do not add new dependencies on waiterPin/kitchenPin etc.
// Stored values are scrypt-HASHED (salt:derived, see lib/pinCrypto).
// Bound to the dedicated bono/orders connection.

import mongoose from "mongoose";

const ActiveWaiterSchema = new mongoose.Schema(
  {
    waiterNumber: { type: Number, required: true },
    deviceSessionId: { type: String, required: true },
    loggedInAt: { type: Date, default: () => new Date() },
    // Phase 6.5: sessionVersion for invalidation after manager reset (old cookie becomes invalid)
    sessionVersion: { type: Number, default: () => Date.now() },
    // Auditable linkage to canonical Staff
    staffId: { type: String, default: null },
    waiterName: { type: String, default: null },
  },
  { _id: false }
);

const SystemAuthSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "system" },
    waiterPin: { type: String, required: true, default: "1111" },
    kitchenPin: { type: String, required: true, default: "2222" },
    baristaPin: { type: String, required: true, default: "3333" },
    managerPin: { type: String, required: true, default: "4444" },
    activeWaiters: { type: [ActiveWaiterSchema], default: [] },
  },
  { timestamps: true }
);

// Multikey index so lockWaiter's positional updateOne / unlock filters on
// activeWaiters.waiterNumber stay indexed (singleton doc, but arrays can grow).
SystemAuthSchema.index({ "activeWaiters.waiterNumber": 1 });

export function getSystemAuthModel(connection) {
  return (
    connection.models.SystemAuth ||
    connection.model("SystemAuth", SystemAuthSchema, "system_auth")
  );
}

const SystemAuth =
  mongoose.models.SystemAuth ||
  mongoose.model("SystemAuth", SystemAuthSchema, "system_auth");

export default SystemAuth;
export { SystemAuthSchema };
