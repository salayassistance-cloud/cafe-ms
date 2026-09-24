import { getStaffModel, STAFF_ROLES } from "@/lib/models/Staff";
import { hashPin, verifyPin, isHashedPin } from "@/lib/pinCrypto";

const PIN_RE = /^\d{4}$/;

// AUTH-ARCH-8B: DEFAULT STAFF BOOTSTRAP REMOVED.
//
// The former DEFAULT_STAFF list (well-known names + PINs) and
// ensureDefaultStaff() automatic creation/repair used to run on every login.
// That is now prohibited: a missing Staff account MUST fail authentication,
// and provisioning belongs exclusively to authorized Staff Management.
//
// Operational note for virgin databases: the FIRST Manager account must be
// provisioned explicitly out-of-band (operator-run, one-time) before any
// login can succeed. There is intentionally no automatic fallback anymore.
// See the AUTH-ARCH-8B final report for the required procedure.

/**
 * Validate role enum.
 */
export function isValidRole(role) {
  return STAFF_ROLES.includes(role);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find staff by exact name/username + role (case-insensitive for username).
 * For WAITER, username is canonical (lowercase). Falls back to name for legacy.
 * PERFORMANCE FIX: Previously up to 4 sequential round trips per login.
 * Now single $or query — one DB round trip.
 */
export async function findStaff(conn, name, role) {
  if (!name || !role) return null;
  const Staff = getStaffModel(conn);
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const escaped = escapeRegex(trimmed);
  if (role === "WAITER") {
    // Single query covering all aliases — one round trip instead of four sequential
    const doc = await Staff.findOne({
      role,
      $or: [
        { username: lower },
        { username: { $regex: `^${escaped}$`, $options: "i" } },
        { name: trimmed },
        { name: { $regex: `^${escaped}$`, $options: "i" } },
      ],
    });
    return doc;
  }
  // For other roles, try name exact then case-insensitive in one query
  const doc = await Staff.findOne({
    role,
    $or: [{ name: trimmed }, { name: { $regex: `^${escaped}$`, $options: "i" } }],
  });
  return doc;
}

export async function verifyStaffPin(conn, name, pin, role) {
  if (!PIN_RE.test(String(pin))) return { ok: false, error: "PIN must be 4 digits" };
  if (!isValidRole(role)) return { ok: false, error: "Invalid role" };
  const staff = await findStaff(conn, name, role);
  if (!staff) return { ok: false, error: "Invalid Name or PIN" };
  if (staff.isActive === false) return { ok: false, error: "Invalid Name or PIN" };
  const stored = staff.pinHash;
  let valid = false;
  if (isHashedPin(stored)) {
    valid = verifyPin(pin, stored);
  } else {
    // Legacy plaintext (should not happen after migration)
    valid = String(stored) === String(pin);
    if (valid) {
      // Upgrade to hash
      staff.pinHash = hashPin(String(pin));
      await staff.save().catch(() => {});
    }
  }
  if (!valid) return { ok: false, error: "Invalid Name or PIN" };
  return { ok: true, staff };
}

/**
 * Verify a PIN against the Staff record addressed by session staffId.
 * Used for step-up re-authentication of destructive operations (e.g.
 * clear-orders): the credential checked is the REQUESTING STAFF MEMBER's own
 * PIN — never a shared role PIN, never SystemAuth. Read-only (no hash
 * upgrade writes); returns { ok } only.
 */
export async function verifyStaffPinById(conn, staffId, pin) {
  if (!staffId) return { ok: false, error: "staffId required" };
  if (!PIN_RE.test(String(pin))) return { ok: false, error: "PIN must be 4 digits" };
  const Staff = getStaffModel(conn);
  const staff = await Staff.findById(staffId).select("pinHash isActive role").lean();
  if (!staff) return { ok: false, error: "Invalid PIN" };
  if (staff.isActive === false) return { ok: false, error: "Invalid PIN" };
  const stored = staff.pinHash;
  let valid = false;
  if (isHashedPin(stored)) {
    valid = verifyPin(pin, stored);
  } else {
    // Legacy plaintext (should not happen after migration)
    valid = String(stored) === String(pin);
  }
  if (!valid) return { ok: false, error: "Invalid PIN" };
  return { ok: true };
}

/**
 * Change PIN for a staff member. Validates current PIN, then hashes new PIN.
 */
export async function changeStaffPin(conn, { staffId, currentPin, newPin }) {
  if (!staffId) return { ok: false, error: "staffId required" };
  if (!PIN_RE.test(String(currentPin))) return { ok: false, error: "Current PIN must be 4 digits" };
  if (!PIN_RE.test(String(newPin))) return { ok: false, error: "New PIN must be exactly 4 digits" };
  if (String(currentPin) === String(newPin)) return { ok: false, error: "New PIN must differ from current PIN" };

  const Staff = getStaffModel(conn);
  const staff = await Staff.findById(staffId);
  if (!staff) return { ok: false, error: "Staff not found" };

  let valid = false;
  if (isHashedPin(staff.pinHash)) {
    valid = verifyPin(currentPin, staff.pinHash);
  } else {
    valid = String(staff.pinHash) === String(currentPin);
  }
  if (!valid) return { ok: false, error: "Current PIN is incorrect" };

  staff.pinHash = hashPin(String(newPin));
  await staff.save();
  return { ok: true, staff };
}

/**
 * Update PIN by name+role (alternative for legacy SystemAuth-style calls).
 */
export async function changePinByNameRole(conn, { name, role, currentPin, newPin }) {
  const staff = await findStaff(conn, name, role);
  if (!staff) return { ok: false, error: "Staff not found" };
  return changeStaffPin(conn, { staffId: staff._id, currentPin, newPin });
}

export async function listStaffByRole(conn, role) {
  const Staff = getStaffModel(conn);
  const filter = role ? { role } : {};
  return Staff.find(filter).select("name username role waiterNumber isActive createdAt updatedAt").sort({ role: 1, waiterNumber: 1, name: 1 }).lean();
}

export async function disableStaff(conn, staffId) {
  const Staff = getStaffModel(conn);
  const staff = await Staff.findById(staffId);
  if (!staff) return { ok: false, error: "Staff not found" };
  if (staff.isActive === false) return { ok: false, error: "Already disabled" };
  staff.isActive = false;
  await staff.save();
  return { ok: true, staff };
}

export async function enableStaff(conn, staffId) {
  const Staff = getStaffModel(conn);
  const staff = await Staff.findById(staffId);
  if (!staff) return { ok: false, error: "Staff not found" };
  staff.isActive = true;
  await staff.save();
  return { ok: true, staff };
}


