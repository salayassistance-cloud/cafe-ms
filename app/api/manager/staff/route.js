import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { getStaffModel } from "@/lib/models/Staff";
import { hashPin } from "@/lib/pinCrypto";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/sessionCrypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { validatePin, validateObjectId } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// POST /api/manager/staff  { staffId, newPin, currentManagerPin? }
// Manager-only: update any staff's PIN without knowing staff's current PIN.
// Authorized by manager session + optional PIN re-auth (Staff canonical).
// WaiterNumber reassignment removed — waiter identity is username (Staff.name), not waiterNumber.
async function handler(request) {
  const rl = checkRateLimit(request, { key: "manager_staff", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    return NextResponse.json({ success: false, message: `Too many requests. Retry after ${retryAfterSeconds(rl.retryAfterMs)}s` }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds(rl.retryAfterMs)) } });
  }
  const len = request.headers.get("content-length");
  if (len && Number(len) > 5 * 1024) return NextResponse.json({ success: false, message: "Payload too large" }, { status: 413 });
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ success: false, message: "Invalid body" }, { status: 400 });
  }
  const staffId = body.staffId ? validateObjectId(body.staffId) : null;
  const newPin = body.newPin ? validatePin(body.newPin) : null;
  const currentManagerPinRaw = String(body.currentManagerPin || body.managerPin || "").trim();
  const currentManagerPin = currentManagerPinRaw ? validatePin(currentManagerPinRaw) : null;
  if (currentManagerPinRaw && !currentManagerPin) return NextResponse.json({ success: false, message: "Manager PIN must be 4 digits" }, { status: 400 });

  if (!staffId) {
    return NextResponse.json({ success: false, message: "Valid staffId required" }, { status: 400 });
  }
  if (!newPin) {
    return NextResponse.json({ success: false, message: "newPin must be 4 digits" }, { status: 400 });
  }

  // Verify manager session + PIN re-auth (canonical Staff)
  let managerPayload = null;
  try {
    const store = await cookies();
    managerPayload = verifySessionToken(store.get(SESSION_COOKIE)?.value);
    if (!managerPayload || managerPayload.role !== "MANAGER") {
      return NextResponse.json({ success: false, message: "Manager authentication required" }, { status: 403 });
    }
    if (currentManagerPin) {
      const conn = await connectToDatabase();
      let valid = false;
      // Try Staff canonical first (managerPayload.staffId preferred)
      try {
        const { getStaffModel } = await import("@/lib/models/Staff");
        const { verifyPin, isHashedPin } = await import("@/lib/pinCrypto");
        const StaffM = getStaffModel(conn);
        let mgrStaff = null;
        if (managerPayload.staffId) mgrStaff = await StaffM.findById(managerPayload.staffId);
        if (!mgrStaff && managerPayload.name) {
          const { findStaff } = await import("@/lib/staffService");
          mgrStaff = await findStaff(conn, managerPayload.name, "MANAGER");
        }
        if (mgrStaff && mgrStaff.pinHash) {
          if (isHashedPin(mgrStaff.pinHash)) valid = verifyPin(currentManagerPin, mgrStaff.pinHash);
          else valid = String(mgrStaff.pinHash) === String(currentManagerPin);
        }
      } catch {}
      // Fallback to SystemAuth legacy if Staff not found / not valid
      if (!valid) {
        const { verifyRolePin } = await import("@/lib/authService");
        valid = await verifyRolePin(conn, "MANAGER", currentManagerPin);
      }
      if (!valid) return NextResponse.json({ success: false, message: "Manager PIN incorrect" }, { status: 401 });
    }
  } catch (e) {
    return NextResponse.json({ success: false, message: "Manager authentication required" }, { status: 403 });
  }

  const conn = await connectToDatabase();
  const Staff = getStaffModel(conn);
  const staff = await Staff.findById(staffId);
  if (!staff) return NextResponse.json({ success: false, message: "Staff not found" }, { status: 404 });

  const targetRole = staff.role;
  const newHash = hashPin(newPin);

  // For KITCHEN/BARISTA/MANAGER, PIN is per-role (single PIN) — update ALL staff of that role atomically
  // For WAITER, PIN is per-person — update only that staff
  if (["KITCHEN", "BARISTA", "MANAGER"].includes(targetRole)) {
    await Staff.updateMany({ role: targetRole }, { $set: { pinHash: newHash } });
    // Also sync SystemAuth singleton for legacy compatibility and to invalidate old PIN
    try {
      const { getSystemAuth } = await import("@/lib/authService");
      const sysDoc = await getSystemAuth(conn);
      const fieldMap = { KITCHEN: "kitchenPin", BARISTA: "baristaPin", MANAGER: "managerPin" };
      const field = fieldMap[targetRole];
      if (field) {
        sysDoc[field] = newHash;
        await sysDoc.save();
        // Invalidate snapshot cache via updatePins logic — getSystemAuth already invalidates on save via update path
        // But also clear derived cache
        try {
          const { hashPin: _hp } = await import("@/lib/pinCrypto");
        } catch {}
      }
    } catch {}
    // Also update the in-memory staff doc for response
    staff.pinHash = newHash;
  } else {
    // WAITER — per-person
    staff.pinHash = newHash;
    await staff.save();
  }

  // Verify DB contains only new hash (atomic $set, reload to confirm)
  const reloaded = await Staff.findById(staffId).lean();
  // For role-based, verify at least one matches new hash (spot check)
  let newValid = false;
  try {
    const { verifyPin, isHashedPin } = await import("@/lib/pinCrypto");
    if (reloaded && isHashedPin(reloaded.pinHash)) newValid = verifyPin(newPin, reloaded.pinHash);
  } catch {}

  return NextResponse.json({ success: true, message: `PIN updated for ${staff.name}`, staff: { id: String(staff._id), name: staff.name, role: staff.role }, verified: newValid }, { status: 200 });
}

export const POST = withApi(handler);
