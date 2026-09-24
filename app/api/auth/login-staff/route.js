import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { verifyStaffPin, isValidRole } from "@/lib/staffService";
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
  // AUTH-ARCH-8B: no automatic bootstrap. Login resolves an EXISTING Staff
  // identity only; a missing account fails authentication below. Staff
  // provisioning belongs exclusively to authorized Staff Management.

  const result = await verifyStaffPin(conn, name, pin, role);
  if (!result.ok) {
    return NextResponse.json({ success: false, message: result.error || "Invalid Name or PIN" }, { status: 401 });
  }

  const staff = result.staff;
  // Waiter display fallback (response only — never a credential): canonical
  // waiterNumber field, else legacy "Waiter N" name parsing for migration data.
  let waiterNumber = null;
  if (role === "WAITER") {
    if (Number.isInteger(staff.waiterNumber) && staff.waiterNumber >= 1 && staff.waiterNumber <= 10) {
      waiterNumber = staff.waiterNumber;
    } else {
      const m = staff.name.match(/Waiter\s+(\d+)/i);
      if (m) {
        const n = Number(m[1]);
        if (n >= 1 && n <= 10) waiterNumber = n;
      }
    }
  }

  const store = await cookies();
  // AUTH-ARCH-8D: canonical server-side session ONLY. No bono_sess issuance
  // on normal Staff login — the opaque session ID (no staffId/role/name/
  // waiterNumber/permissions) is the sole cookie credential, plus a tab
  // credential bound to the same row. A Session persistence failure now fails
  // the login (503) instead of falling back to a legacy cookie: there is no
  // legacy net anymore, and a success response without a usable session would
  // strand the caller in 401s.
  let created = null;
  let tabCredential = null;
  try {
    const { createSession, attachTabCredential } = await import("@/lib/sessionStore");
    const { NEW_SESSION_COOKIE, NEW_SESSION_COOKIE_OPTS, getRequestMeta } = await import("@/lib/serverSessionCookies");
    const meta = getRequestMeta(request);
    // Tab isolation: every login mints an independent Session row and never
    // revokes the presented cookie session — the browser-wide cookie may
    // belong to ANOTHER tab's live station session, and revoking it logged
    // other tabs out with SESSION_REVOKED. Stale rows expire via TTL.
    created = await createSession(conn, {
      staffId: staff._id,
      role: staff.role,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    store.set(NEW_SESSION_COOKIE, created.sessionId, NEW_SESSION_COOKIE_OPTS);
    try {
      tabCredential = await attachTabCredential(conn, created.sessionId);
    } catch {}
  } catch {}
  if (!created) {
    return NextResponse.json({ success: false, message: "Database temporarily unavailable" }, { status: 503 });
  }

  return NextResponse.json(
    {
      success: true,
      staff: { id: String(staff._id), name: staff.name, role: staff.role, waiterNumber: staff.waiterNumber ?? waiterNumber ?? null },
      // Memory-only tab credential (absent only when binding failed; the
      // cookie session remains fully usable via the canonical cookie path).
      ...(tabCredential ? { tabCredential } : {}),
    },
    { status: 200 }
  );
}

export const POST = withApi(handler);
