import mongoose from "mongoose";

export const STAFF_ROLES = ["WAITER", "KITCHEN", "BARISTA", "MANAGER"];

/**
 * Staff Model — auditable, per-person identity for all portals.
 * Replaces the legacy singleton SystemAuth PIN store with a proper collection
 * where each staff member has a unique `name` scoped to their `role` and a
 * securely hashed `pinHash` (scrypt via lib/pinCrypto, compatible with bcrypt
 * requirement — both are secure KDFs; scrypt is already used for SystemAuth).
 *
 * Fields:
 *  - name: String (e.g., "Abel", "Kebebe") — unique per role
 *  - pinHash: String — scrypt salt:derived hex (never plaintext)
 *  - role: Enum WAITER | KITCHEN | BARISTA | MANAGER
 *  - timestamps: createdAt, updatedAt
 */
const StaffSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 50,
    },
    // Normalized username for WAITER login — lowercase, unique per role. For non-WAITER, may be null.
    username: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 50,
      default: null,
      index: true,
    },
    pinHash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: STAFF_ROLES,
      required: true,
      index: true,
    },
    // Legacy waiter number for WAITER role — 1..10, unique among WAITER records.
    // Kept for historical orders compatibility. New waiter auth uses username+PIN only,
    // waiterNumber is NOT used for authentication and may be null for new waiters.
    waiterNumber: {
      type: Number,
      min: 1,
      max: 10,
      default: null,
      index: true,
    },
    // Soft-disable flag for waiter account lifecycle. Manager disables instead of hard-delete
    // to preserve historical Order.waiterId → Staff._id references.
    // True = active/can authenticate, False = disabled/cannot authenticate.
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true, collection: "staffs" }
);

// Unique per role: two waiters can share a name across roles, but not within same role
StaffSchema.index({ name: 1, role: 1 }, { unique: true });
StaffSchema.index({ role: 1, createdAt: -1 });
StaffSchema.index({ role: 1, isActive: 1 });
// Username for WAITER login — normalized lowercase, unique per role (case-insensitive uniqueness)
StaffSchema.index({ username: 1, role: 1 }, { unique: true, partialFilterExpression: { username: { $type: "string" } } });
// Canonical waiterNumber uniqueness among WAITER records (non-WAITER have null) — kept for legacy
StaffSchema.index({ role: 1, waiterNumber: 1 }, { unique: true, partialFilterExpression: { role: "WAITER", waiterNumber: { $type: "number" } } });

StaffSchema.pre("validate", function () {
  if (this.role === "WAITER") {
    if (this.waiterNumber != null && (!Number.isInteger(this.waiterNumber) || this.waiterNumber < 1 || this.waiterNumber > 10)) {
      throw new Error("waiterNumber must be integer 1..10");
    }
    // New waiters may have null waiterNumber — username is identity, not waiterNumber
    if (this.isActive == null) this.isActive = true;
    // Normalize username: if not set, derive from name (lowercase)
    if (!this.username && this.name) {
      this.username = String(this.name).trim().toLowerCase();
    } else if (this.username) {
      this.username = String(this.username).trim().toLowerCase();
    }
  } else if (this.waiterNumber != null) {
    this.waiterNumber = null;
  }
  if (this.isActive == null) this.isActive = true;
  // For non-WAITER, ensure username is at least derived from name if provided
  if (this.role !== "WAITER" && this.username) {
    this.username = String(this.username).trim().toLowerCase();
  }
});

export function getStaffModel(connection) {
  return connection.models.Staff || connection.model("Staff", StaffSchema, "staffs");
}

// Default model for scripts (single-connection mode)
const Staff = mongoose.models.Staff || mongoose.model("Staff", StaffSchema, "staffs");
export default Staff;
export { StaffSchema };
