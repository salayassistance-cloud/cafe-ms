import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { getStaffModel, STAFF_ROLES } from "@/lib/models/Staff";
import { hashPin } from "@/lib/pinCrypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { validatePin, validateObjectId, sanitizeName } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { ok, fail } from "@/lib/apiResponse";
import { requireAuth } from "@/lib/security";

export const dynamic = "force-dynamic";

// GET /api/manager/staff — Manager-only staff listing with safe fields only
// Query: ?role=WAITER|KITCHEN|BARISTA|MANAGER|CASHIER|ALL  &status=active|disabled|all  &search=...
// Returns: { staff: [{id,name,username,role,isActive,waiterNumber,createdAt,updatedAt}], counts: {total,active,disabled,byRole} }
async function getHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  const rl = checkRateLimit(request, { key: "manager_staff_list", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database temporarily unavailable", 503);
  }
  const { searchParams } = new URL(request.url);
  const roleRaw = searchParams.get("role");
  const statusRaw = searchParams.get("status");
  const searchRaw = searchParams.get("search");
  const search = searchRaw ? String(searchRaw).trim().toLowerCase() : null;

  let filter = {};
  if (roleRaw && String(roleRaw).trim() !== "" && String(roleRaw).trim().toUpperCase() !== "ALL") {
    const r = String(roleRaw).trim().toUpperCase();
    if (!STAFF_ROLES.includes(r)) return fail("Invalid role filter", 400);
    filter.role = r;
  }
  if (statusRaw && String(statusRaw).trim() !== "" && String(statusRaw).trim().toLowerCase() !== "all") {
    const s = String(statusRaw).trim().toLowerCase();
    if (s === "active") filter.isActive = { $ne: false };
    else if (s === "disabled" || s === "inactive" || s === "trash") filter.isActive = false;
    else return fail("Invalid status filter (use active|disabled|all)", 400);
  }

  const Staff = getStaffModel(conn);
  const list = await Staff.find(filter).select("name username role waiterNumber isActive createdAt updatedAt").sort({ role: 1, name: 1 }).lean();

  let data = list.map((s) => ({
    id: String(s._id),
    name: s.name,
    username: s.username || String(s.name).toLowerCase(),
    role: s.role,
    isActive: s.isActive !== false,
    waiterNumber: s.waiterNumber ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));

  // Server-side search by name or username (case-insensitive contains)
  if (search) {
    data = data.filter((d) => String(d.name).toLowerCase().includes(search) || String(d.username).toLowerCase().includes(search));
  }

  const total = list.length;
  const active = list.filter((s) => s.isActive !== false).length;
  const disabled = list.filter((s) => s.isActive === false).length;
  const byRole = {};
  for (const r of STAFF_ROLES) byRole[r] = list.filter((s) => s.role === r).length;

  // Also filtered counts after search for UI convenience
  const filteredTotal = data.length;
  return ok({ staff: data, counts: { total, active, disabled, byRole, filteredTotal } }, 200);
}

// PATCH /api/manager/staff — Manager-only update of safe fields (name, username, isActive)
// Body: { staffId, name?, username?, isActive? }  — role change NOT allowed, MANAGER creation NOT allowed via PATCH
async function patchHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);
  const rl = checkRateLimit(request, { key: "manager_staff_patch", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  const len = request.headers.get("content-length");
  if (len && Number(len) > 5 * 1024) return fail("Payload too large", 413);
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid JSON body", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid request body", 400);

  const rawId = body.staffId || body.id || null;
  if (!rawId) return fail("staffId is required", 400);
  const staffId = validateObjectId(String(rawId));
  if (!staffId) return fail("Invalid staffId", 400);

  // Strictly forbid role changes
  if (body.role !== undefined && body.role !== null && String(body.role).trim() !== "") {
    const rRaw = String(body.role).trim().toUpperCase();
    // Even if client sends same role, we treat any role field as forbidden to keep API tight (use existing creation path for new accounts)
    return fail("Role change not allowed via this endpoint", 400);
  }

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database temporarily unavailable", 503);
  }
  const Staff = getStaffModel(conn);
  const staff = await Staff.findById(staffId);
  if (!staff) return fail("Staff not found", 404);

  const updates = {};

  if (body.name !== undefined) {
    const rawName = String(body.name).trim();
    if (!rawName) return fail("Name is required (1-50 chars)", 400);
    const name = sanitizeName(rawName);
    if (!name) return fail("Name contains invalid characters", 400);
    if (name !== staff.name) {
      const dup = await Staff.findOne({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" }, role: staff.role, _id: { $ne: staff._id } });
      if (dup) return fail("Name already exists for this role.", 409);
      updates.name = name;
    }
  }

  if (body.username !== undefined) {
    const raw = String(body.username).trim();
    if (!raw || raw.length < 2 || raw.length > 30) return fail("Username must be 2-30 characters", 400);
    if (!/^[a-zA-Z0-9._-]+$/.test(raw)) return fail("Username may contain only letters, numbers, dot, underscore, dash", 400);
    const username = raw.toLowerCase();
    if (username !== String(staff.username || "").toLowerCase()) {
      const dupUser = await Staff.findOne({ username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" }, role: staff.role, _id: { $ne: staff._id } });
      if (dupUser) return fail("Username already exists.", 409);
      updates.username = username;
    }
  }

  if (body.isActive !== undefined) {
    let wantActive;
    const rawActive = body.isActive;
    if (typeof rawActive === "boolean") wantActive = rawActive;
    else if (typeof rawActive === "string") {
      const s = rawActive.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "active") wantActive = true;
      else if (s === "false" || s === "0" || s === "disabled" || s === "inactive") wantActive = false;
      else return fail("isActive must be true/false", 400);
    } else if (typeof rawActive === "number") wantActive = !!rawActive;
    else wantActive = !!rawActive;

    // Only WAITER/CASHIER individual accounts can be toggled; shared roles (KITCHEN/BARISTA/MANAGER) are not individual and must not be disabled via this UI
    if (!["WAITER", "CASHIER"].includes(staff.role)) {
      return fail("Only WAITER or CASHIER accounts can be enabled/disabled individually", 400);
    }
    if ((staff.isActive !== false) === wantActive) {
      // No change — treat as success idempotently
    } else {
      updates.isActive = wantActive;
    }
  }

  if (Object.keys(updates).length === 0) return fail("No updatable fields provided (name, username, isActive)", 400);

  try {
    const updated = await Staff.findByIdAndUpdate(staffId, { $set: updates }, { new: true, runValidators: true });
    if (!updated) return fail("Staff not found", 404);
    // AUTH-ARCH-3: disabling an account revokes its server-side sessions.
    // Best-effort — the disable itself already succeeded.
    if (updates.isActive === false) {
      try {
        const { revokeAllStaffSessions } = await import("@/lib/sessionStore");
        await revokeAllStaffSessions(conn, staffId, "DISABLED");
      } catch {}
    }
    return ok(
      {
        updated: true,
        staff: {
          id: String(updated._id),
          name: updated.name,
          username: updated.username || String(updated.name).toLowerCase(),
          role: updated.role,
          isActive: updated.isActive !== false,
          waiterNumber: updated.waiterNumber ?? null,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
      },
      200
    );
  } catch (e) {
    if (e?.code === 11000) return fail("Duplicate username or name", 409);
    return fail(e.message || "Failed to update staff", 500);
  }
}

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
  const currentManagerPinRaw = String(body.currentManagerPin || "").trim();
  const currentManagerPin = currentManagerPinRaw ? validatePin(currentManagerPinRaw) : null;
  if (currentManagerPinRaw && !currentManagerPin) return NextResponse.json({ success: false, message: "Manager PIN must be 4 digits" }, { status: 400 });

  if (!staffId) {
    return NextResponse.json({ success: false, message: "Valid staffId required" }, { status: 400 });
  }
  if (!newPin) {
    return NextResponse.json({ success: false, message: "newPin must be 4 digits" }, { status: 400 });
  }

  // Verify manager session via the canonical resolver (AUTH-ARCH-4):
  // live Staff.role === MANAGER (tab credential first, then the canonical
  // server session) + optional PIN re-auth below.
  let managerPayload = null;
  try {
    const store = await cookies();
    const { getLiveSessionFromCookies } = await import("@/lib/serverAuth");
    managerPayload = await getLiveSessionFromCookies(store, ["MANAGER"]);
    if (!managerPayload) {
      return NextResponse.json({ success: false, message: "Manager authentication required" }, { status: 403 });
    }
    if (currentManagerPin) {
      const conn = await connectToDatabase();
      // AUTH-ARCH-8F: step-up re-auth against the requesting MANAGER's own
      // Staff PIN only. The former SystemAuth role-PIN fallback is removed:
      // a missing Staff record fails closed instead of consulting legacy.
      const { verifyStaffPinById } = await import("@/lib/staffService");
      const checked = await verifyStaffPinById(conn, managerPayload.staffId, currentManagerPin);
      if (!checked.ok) return NextResponse.json({ success: false, message: "Manager PIN incorrect" }, { status: 401 });
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
  // AUTH-ARCH-8C/8F: Staff-only. SystemAuth is never written by PIN
  // management (the former role-PIN mirror is retired with authService).
  // Mirroring the new PIN into a second store would only preserve a
  // duplicate credential authority.
  if (["KITCHEN", "BARISTA", "MANAGER"].includes(targetRole)) {
    await Staff.updateMany({ role: targetRole }, { $set: { pinHash: newHash } });
    // Also update the in-memory staff doc for response
    staff.pinHash = newHash;
  } else {
    // WAITER/CASHIER — per-person
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

  // AUTH-ARCH-3: manager PIN reset invalidates the target's server-side
  // sessions. Role-wide resets (KITCHEN/BARISTA/MANAGER share one PIN) also
  // revoke that role's sessions. Scoped to affected identities only.
  // Best-effort: the reset already succeeded and stays reported as success.
  try {
    const { revokeAllStaffSessions, revokeRoleSessions } = await import("@/lib/sessionStore");
    await revokeAllStaffSessions(conn, staffId, "PIN_RESET");
    if (["KITCHEN", "BARISTA", "MANAGER"].includes(targetRole)) {
      await revokeRoleSessions(conn, targetRole, "PIN_RESET");
    }
  } catch {}

  return NextResponse.json({ success: true, message: `PIN updated for ${staff.name}`, staff: { id: String(staff._id), name: staff.name, role: staff.role }, verified: newValid }, { status: 200 });
}

export const GET = withApi(getHandler);
export const POST = withApi(handler);
export const PATCH = withApi(patchHandler);
