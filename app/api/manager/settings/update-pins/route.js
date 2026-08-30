import { connectToDatabase } from "@/lib/mongodb";
import { verifyRolePin, updatePins } from "@/lib/authService";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { validatePin } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";

export const dynamic = "force-dynamic";

// POST /api/manager/settings/update-pins
// Manager-only PIN administration — LEGACY COMPATIBILITY (SystemAuth role PINs).
// Requires MANAGER session + re-auth with currentManagerPin (Staff canonical first,
// SystemAuth fallback), then atomically updates SystemAuth role PINs.
// For KITCHEN/BARISTA/MANAGER, also syncs corresponding Staff pinHash so canonical
// Staff remains authoritative. For WAITER, SystemAuth waiterPin is legacy only;
// individual waiter PINs must be managed via /api/manager/staff with staffId
// (individual credential). This endpoint is kept for emergency compatibility and
// will be removed once Staff migration is fully verified.
async function handler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);

  const rl = checkRateLimit(request, { key: "update_pins", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  const len = request.headers.get("content-length");
  if (len && Number(len) > 5 * 1024) return fail("Payload too large", 413);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Invalid request body", 400);
  }

  const currentManagerPin = validatePin(body.currentManagerPin);
  if (!currentManagerPin) {
    return fail("Current manager PIN required (4 digits) for re-authentication", 400);
  }

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database temporarily unavailable", 503);
  }
  // Re-auth: Staff canonical first, SystemAuth fallback
  let authorised = false;
  try {
    const { getStaffModel } = await import("@/lib/models/Staff");
    const { verifyPin, isHashedPin } = await import("@/lib/pinCrypto");
    const StaffM = getStaffModel(conn);
    let mgrStaff = null;
    if (auth.payload.staffId) mgrStaff = await StaffM.findById(auth.payload.staffId);
    if (!mgrStaff && auth.payload.name) {
      const { findStaff } = await import("@/lib/staffService");
      mgrStaff = await findStaff(conn, auth.payload.name, "MANAGER");
    }
    if (mgrStaff && mgrStaff.pinHash) {
      if (isHashedPin(mgrStaff.pinHash)) authorised = verifyPin(currentManagerPin, mgrStaff.pinHash);
      else authorised = String(mgrStaff.pinHash) === String(currentManagerPin);
    }
  } catch {}
  if (!authorised) authorised = await verifyRolePin(conn, "MANAGER", currentManagerPin);
  if (!authorised) {
    return fail("Manager PIN incorrect", 401);
  }

  const pins = {
    WAITER: validatePin(body.waiterPin),
    KITCHEN: validatePin(body.kitchenPin),
    BARISTA: validatePin(body.baristaPin),
    MANAGER: validatePin(body.managerPin),
  };

  for (const [role, pin] of Object.entries(pins)) {
    if (!pin) {
      return fail(`${role} PIN must be exactly 4 digits`, 400);
    }
  }

  const res = await updatePins(conn, pins);
  if (!res.ok) return fail(res.error, 400);

  // Sync canonical Staff for KITCHEN/BARISTA/MANAGER so Staff remains source of truth
  try {
    const { getStaffModel } = await import("@/lib/models/Staff");
    const { hashPin } = await import("@/lib/pinCrypto");
    const Staff = getStaffModel(conn);
    for (const role of ["KITCHEN", "BARISTA", "MANAGER"]) {
      const pin = pins[role];
      const docs = await Staff.find({ role });
      for (const doc of docs) {
        doc.pinHash = hashPin(pin);
        await doc.save().catch(() => {});
      }
    }
    // WAITER: intentionally NOT mass-updating individual waiter PINs — legacy SystemAuth waiterPin only
  } catch {}

  return ok({ updated: true, legacyWaiterPinOnly: true });
}

export const POST = withApi(handler);
