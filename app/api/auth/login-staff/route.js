import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { verifyStaffPin, ensureDefaultStaff, isValidRole } from "@/lib/staffService";
import { createSessionToken, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/sessionCrypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { validateLoginStaffPayload } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login-staff
 * Body: { name, pin, role }
 * Verifies staff exists for role and pin matches pinHash.
 * On success: returns { success, staff: { id, name, role } } and sets HTTP-only session cookie.
 * On failure: 401 with "Invalid Name or PIN"
 */
async function handler(request) {
  const rl = checkRateLimit(request, { key: "login_staff", ...RATE_LIMITS.AUTH });
  if (!rl.ok) {
    return NextResponse.json({ success: false, message: `Too many attempts. Retry after ${retryAfterSeconds(rl.retryAfterMs)}s` }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds(rl.retryAfterMs)) } });
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
    return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
  }

  const validated = validateLoginStaffPayload(body);
  if (!validated.ok) {
    return NextResponse.json({ success: false, message: validated.error }, { status: 400 });
  }
  const { name, pin, role } = validated.data;
  if (!isValidRole(role)) {
    return NextResponse.json({ success: false, message: "Invalid role" }, { status: 400 });
  }

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return NextResponse.json({ success: false, message: "Database temporarily unavailable" }, { status: 503 });
  }
  try {
    await ensureDefaultStaff(conn);
  } catch {}

  const result = await verifyStaffPin(conn, name, pin, role);
  if (!result.ok) {
    return NextResponse.json({ success: false, message: result.error || "Invalid Name or PIN" }, { status: 401 });
  }

  const staff = result.staff;
  const payload = {
    role,
    staffId: String(staff._id),
    name: staff.name,
    staffName: staff.name,
  };
  // For waiter, also include waiterName/Number (canonical waiterNumber field, not name parsing)
  if (role === "WAITER") {
    payload.waiterName = staff.name;
    if (Number.isInteger(staff.waiterNumber) && staff.waiterNumber >= 1 && staff.waiterNumber <= 10) {
      payload.waiterNumber = staff.waiterNumber;
    } else {
      // Legacy fallback: parse "Waiter N" from name only if waiterNumber not set (migration compatibility)
      const m = staff.name.match(/Waiter\s+(\d+)/i);
      if (m) {
        const n = Number(m[1]);
        if (n >= 1 && n <= 10) payload.waiterNumber = n;
      }
    }
  }

  const token = createSessionToken(payload);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, SESSION_COOKIE_OPTS);

  return NextResponse.json(
    {
      success: true,
      staff: { id: String(staff._id), name: staff.name, role: staff.role, waiterNumber: staff.waiterNumber ?? payload.waiterNumber ?? null },
    },
    { status: 200 }
  );
}

export const POST = withApi(handler);
