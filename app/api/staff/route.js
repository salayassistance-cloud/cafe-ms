import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { getStaffModel } from "@/lib/models/Staff";
import { ok, fail } from "@/lib/apiResponse";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";
import { validateRole } from "@/lib/validate";
import { verifyPin, isHashedPin } from "@/lib/pinCrypto";

export const dynamic = "force-dynamic";

// GET /api/staff?role=WAITER
// Returns list of staff (id, name, role). Protected: requires an authenticated session.
async function handler(request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return fail(auth.error, auth.status);
  const rl = checkRateLimit(request, { key: "staff_list", ...RATE_LIMITS.GENERAL });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }

  const { searchParams } = new URL(request.url);
  const rawRole = searchParams.get("role");
  const role = rawRole ? validateRole(String(rawRole).toUpperCase()) : null;
  if (rawRole && !role) return fail("Invalid role filter", 400);

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database temporarily unavailable", 503);
  }
  const Staff = getStaffModel(conn);
  const filter = role ? { role } : {};
  // For MANAGER, also fetch pinHash to compute pinStatus (DEFAULT vs CUSTOM) without exposing hash
  const isManager = String(auth.payload.role).toUpperCase() === "MANAGER";
  const projection = isManager ? "name role waiterNumber pinHash createdAt updatedAt" : "name role waiterNumber createdAt updatedAt";
  const list = await Staff.find(filter).select(projection).sort({ role: 1, waiterNumber: 1, name: 1 }).lean();
  // Compute pinStatus server-side (never return hash)
  let pinStatusMap = null;
  if (isManager) {
    try {
      const { DEFAULT_WAITER_PIN, DEFAULT_KITCHEN_PIN, DEFAULT_BARISTA_PIN, DEFAULT_MANAGER_PIN } = await import("@/lib/config/security");
      const defaults = {
        WAITER: DEFAULT_WAITER_PIN,
        KITCHEN: DEFAULT_KITCHEN_PIN,
        BARISTA: DEFAULT_BARISTA_PIN,
        MANAGER: DEFAULT_MANAGER_PIN,
      };
      pinStatusMap = new Map();
      for (const s of list) {
        const def = defaults[s.role];
        let isDefault = false;
        if (def && s.pinHash) {
          try {
            if (isHashedPin(s.pinHash)) isDefault = verifyPin(def, s.pinHash);
            else isDefault = String(s.pinHash) === String(def);
          } catch {}
        }
        pinStatusMap.set(String(s._id), isDefault ? "DEFAULT" : "CUSTOM");
      }
    } catch {}
  }
  const data = list.map((s) => ({
    id: String(s._id),
    name: s.name,
    role: s.role,
    waiterNumber: s.waiterNumber ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ...(isManager && pinStatusMap ? { pinStatus: pinStatusMap.get(String(s._id)) || "CUSTOM" } : {}),
  }));
  return ok({ staff: data }, 200);
}

export const GET = withApi(handler);
