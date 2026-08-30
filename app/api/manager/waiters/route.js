import { connectToDatabase } from "@/lib/mongodb";
import { getStaffModel } from "@/lib/models/Staff";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { requireAuth } from "@/lib/security";
import { sanitizeName, validatePin } from "@/lib/validate";
import { hashPin } from "@/lib/pinCrypto";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// GET /api/manager/waiters — list waiter accounts (manager only)
// Query ?status=active|trash|all (default all). Active = isActive !== false, Trash = isActive === false
// Returns waiter accounts with id, name, role, isActive, waiterNumber (no pinHash)
async function getHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  const rl = checkRateLimit(request, { key: "manager_waiters_list", ...RATE_LIMITS.MANAGER });
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
  const status = String(searchParams.get("status") || "all").toLowerCase();
  const Staff = getStaffModel(conn);
  let filter = { role: "WAITER" };
  if (status === "active") filter.isActive = { $ne: false };
  else if (status === "trash") filter.isActive = false;
  const list = await Staff.find(filter).select("name username role waiterNumber isActive createdAt updatedAt").sort({ name: 1 }).lean();
  const data = list.map((s) => ({
    id: String(s._id),
    name: s.name,
    username: s.username || s.name,
    displayName: s.name,
    role: s.role,
    isActive: s.isActive !== false,
    waiterNumber: s.waiterNumber ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
  // For status=all we also provide split counts for convenience
  if (status === "all") {
    const active = data.filter((w) => w.isActive);
    const trash = data.filter((w) => !w.isActive);
    return ok({ waiters: data, active, trash, counts: { active: active.length, trash: trash.length, total: data.length } }, 200);
  }
  return ok({ waiters: data, status }, 200);
}

// POST /api/manager/waiters — create waiter OR disable/delete waiter (soft-disable)
// Create: Body { name, username, pin, confirmPin } — requires MANAGER, validates, hashes, isActive true
// Delete: Body { staffId } or { username } or { name } — requires MANAGER, sets isActive=false
async function postHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  const rl = checkRateLimit(request, { key: "manager_waiters_delete", ...RATE_LIMITS.MANAGER });
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
  if (!body || typeof body !== "object") return fail("Invalid request body", 400);

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database temporarily unavailable", 503);
  }
  const Staff = getStaffModel(conn);

  // CREATE branch: has name+username+pin and no staffId
  const hasStaffId = !!(body.staffId || body.id);
  const hasCreateFields = !!(body.name && body.username && body.pin);
  const isExplicitCreate = String(body.action || "").toLowerCase() === "create";
  if ((hasCreateFields && !hasStaffId) || isExplicitCreate) {
    const rawName = body.name;
    const rawUsername = body.username;
    const rawPin = body.pin;
    const rawConfirm = body.confirmPin || body.confirm || body.pinConfirm || rawPin;

    const name = sanitizeName(rawName);
    if (!name) return fail("Name is required (1-50 chars)", 400);
    const usernameRaw = String(rawUsername || "").trim();
    if (!usernameRaw || usernameRaw.length < 2 || usernameRaw.length > 30) return fail("Username must be 2-30 characters", 400);
    // Username: allow letters, numbers, underscore, dash, dot
    if (!/^[a-zA-Z0-9._-]+$/.test(usernameRaw)) return fail("Username may contain only letters, numbers, dot, underscore, dash", 400);
    const username = usernameRaw.toLowerCase();
    const pin = validatePin(rawPin);
    if (!pin) return fail("PIN must be exactly 4 digits", 400);
    const confirm = String(rawConfirm || "").trim();
    if (pin !== confirm) return fail("PIN and Confirm PIN do not match", 400);

    // Check username uniqueness (case-insensitive)
    const existingByUsername = await Staff.findOne({ username: { $regex: `^${username}$`, $options: "i" }, role: "WAITER" });
    if (existingByUsername) return fail("Username already exists.", 409);
    // Also check name uniqueness if needed? Name is unique per role, but we allow same name different case? Prevent duplicates
    // Check if same username as existing name (legacy)
    const existingByName = await Staff.findOne({ name: { $regex: `^${username}$`, $options: "i" }, role: "WAITER" });
    if (existingByName && !existingByName.username) {
      // Legacy doc where username is derived from name — treat as duplicate
      return fail("Username already exists.", 409);
    }

    try {
      const doc = await Staff.create({ name, username, pinHash: hashPin(pin), role: "WAITER", isActive: true });
      return ok({ created: true, waiter: { id: String(doc._id), name: doc.name, username: doc.username, role: doc.role, isActive: true } }, 201);
    } catch (e) {
      if (e?.code === 11000) return fail("Username already exists.", 409);
      return fail(e.message || "Failed to create waiter", 500);
    }
  }

  // DELETE/DISABLE branch
  const rawId = body.staffId || body.id || null;
  const rawName = body.username || body.name || null;
  if (!rawId && !rawName) return fail("staffId or username required", 400);

  let staff = null;
  if (rawId) {
    if (!/^[a-fA-F0-9]{24}$/.test(String(rawId))) return fail("Invalid staffId", 400);
    staff = await Staff.findById(String(rawId));
  } else if (rawName) {
    const trimmed = String(rawName).trim();
    if (!trimmed) return fail("Invalid username", 400);
    const lower = trimmed.toLowerCase();
    staff = await Staff.findOne({ username: lower, role: "WAITER" });
    if (!staff) staff = await Staff.findOne({ username: { $regex: `^${trimmed}$`, $options: "i" }, role: "WAITER" });
    if (!staff) staff = await Staff.findOne({ name: trimmed, role: "WAITER" });
    if (!staff) staff = await Staff.findOne({ name: { $regex: `^${trimmed}$`, $options: "i" }, role: "WAITER" });
  }
  if (!staff) return fail("Waiter not found", 404);
  if (staff.role !== "WAITER") return fail("Only WAITER accounts can be deleted via this endpoint", 400);
  if (staff.isActive === false) return fail("Account already disabled", 409);

  staff.isActive = false;
  await staff.save();

  return ok({ deleted: true, disabled: true, waiter: { id: String(staff._id), name: staff.name, username: staff.username || staff.name, isActive: false } }, 200);
}

// DELETE /api/manager/waiters — disable/delete waiter (soft-disable)
async function deleteHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  const rl = checkRateLimit(request, { key: "manager_waiters_delete", ...RATE_LIMITS.MANAGER });
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
  if (!body || typeof body !== "object") return fail("Invalid request body", 400);
  const rawId = body.staffId || body.id || null;
  const rawName = body.username || body.name || null;
  if (!rawId && !rawName) return fail("staffId or username required", 400);
  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database temporarily unavailable", 503);
  }
  const Staff = getStaffModel(conn);
  let staff = null;
  if (rawId) {
    if (!/^[a-fA-F0-9]{24}$/.test(String(rawId))) return fail("Invalid staffId", 400);
    staff = await Staff.findById(String(rawId));
  } else if (rawName) {
    const trimmed = String(rawName).trim();
    if (!trimmed) return fail("Invalid username", 400);
    const lower = trimmed.toLowerCase();
    staff = await Staff.findOne({ username: lower, role: "WAITER" });
    if (!staff) staff = await Staff.findOne({ username: { $regex: `^${trimmed}$`, $options: "i" }, role: "WAITER" });
    if (!staff) staff = await Staff.findOne({ name: trimmed, role: "WAITER" });
    if (!staff) staff = await Staff.findOne({ name: { $regex: `^${trimmed}$`, $options: "i" }, role: "WAITER" });
  }
  if (!staff) return fail("Waiter not found", 404);
  if (staff.role !== "WAITER") return fail("Only WAITER accounts can be deleted via this endpoint", 400);
  if (staff.isActive === false) return fail("Account already disabled", 409);
  staff.isActive = false;
  await staff.save();
  return ok({ deleted: true, disabled: true, waiter: { id: String(staff._id), name: staff.name, username: staff.username || staff.name, isActive: false } }, 200);
}

export const GET = withApi(getHandler);
export const POST = withApi(postHandler);
export const DELETE = withApi(deleteHandler);
