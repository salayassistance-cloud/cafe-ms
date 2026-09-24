import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { validatePin, validateRole } from "@/lib/validate";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Process-level derived-key cache for the canonical Staff verify loop.
// scrypt (~70-90ms each) dominates latency when a role has several staff.
// Keyed by `${storedHash}:${pin}`; see usage below. Defined at module scope so
// it survives across warm requests (memoizes repeat terminal sign-ins).
const MAX_DERIVED = 256;
const staffDerivedCache = new Map();

// POST /api/auth/verify-pin
// Kitchen / Barista / Manager sign-in — CANONICAL Staff-based.
// Verifies PIN against Staff.pinHash for the given role (individual credential),
// then issues the canonical server-side session (opaque __Host-bono_session
// cookie + tab credential, no bono_sess on normal Staff login).
// Legacy SystemAuth role PINs (system_auth) are kept only as a bootstrap
// fallback (no Staff for role) for migration compatibility and are explicitly
// marked as legacy. WAITER must use /api/auth/login-staff (username + PIN);
// shared waiterPin is deprecated and will return 400.
// Brute-force protected via rate limiting + strict input validation.
async function handler(request) {
  const rl = checkRateLimit(request, { key: "auth_verify_pin", ...RATE_LIMITS.AUTH });
  if (!rl.ok) {
    return NextResponse.json(
      { success: false, message: `Too many attempts. Retry after ${retryAfterSeconds(rl.retryAfterMs)}s`, error: "Rate limited" },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds(rl.retryAfterMs)) } }
    );
  }
  const len = request.headers.get("content-length");
  if (len && Number(len) > 5 * 1024) {
    return NextResponse.json({ success: false, message: "Payload too large" }, { status: 413 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { success: false, message: "Invalid request body" },
      { status: 400 }
    );
  }

  const role = validateRole(body.role);
  const pin = validatePin(body.pin);

  if (!role) {
    return NextResponse.json(
      { success: false, message: "Invalid role" },
      { status: 400 }
    );
  }
  if (!pin) {
    return NextResponse.json(
      { success: false, message: "Please enter a 4-digit PIN" },
      { status: 400 }
    );
  }

  if (role === "WAITER") {
    return NextResponse.json(
      { success: false, message: "Use Username + PIN login (/api/auth/login-staff)", code: "USE_LOGIN_STAFF" },
      { status: 400 }
    );
  }

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return NextResponse.json({ success: false, message: "Database temporarily unavailable" }, { status: 503 });
  }

  // Canonical: Staff-based verification (individual credential).
  // AUTH-ARCH-8B: no automatic bootstrap. A missing Staff row fails below;
  // provisioning belongs exclusively to authorized Staff Management.

  let staffPayload = null;
  let candidates = [];
  try {
    const { getStaffModel } = await import("@/lib/models/Staff");
    const { verifyPin, isHashedPin } = await import("@/lib/pinCrypto");
    const Staff = getStaffModel(conn);
    candidates = await Staff.find({ role }).lean();

    // ---- Hot-path derived-key cache (scrypt memoization per stored hash) ----
    // scrypt (~70-90ms per call) dominates the per-request cost when a role has
    // several staff (e.g. WAITER has many). Memoize the verification result per
    // `${storedHash}:${pin}` so a terminal's repeat sign-in is a constant-time
    // memory compare instead of another KDF. The key combines the stored hash
    // (which embeds its salt) and the submitted PIN, so a wrong attempt can
    // never shadow the derived key of the correct PIN. No plaintext is stored
    // and the underlying scrypt + timingSafeEqual verification is unchanged.
    const cachedVerifyPin = (p, storedHash) => {
      const key = `${storedHash}:${p}`;
      const cached = staffDerivedCache.get(key);
      if (cached !== undefined) return cached;
      const result = verifyPin(p, storedHash);
      if (staffDerivedCache.size >= MAX_DERIVED) staffDerivedCache.clear();
      staffDerivedCache.set(key, result);
      return result;
    };

    for (const s of candidates) {
      let ok = false;
      if (isHashedPin(s.pinHash)) ok = cachedVerifyPin(pin, s.pinHash);
      else ok = String(s.pinHash) === String(pin);
      if (ok) {
        staffPayload = { role, staffId: String(s._id), name: s.name, staffName: s.name };
        break;
      }
    }
  } catch {}

  if (staffPayload) {
    const store = await cookies();
    // AUTH-ARCH-8D: canonical server-side session ONLY for KITCHEN, BARISTA,
    // MANAGER and CASHIER Staff logins - no bono_sess issuance. Each role
    // keeps its validated Staff identity; substitution is forbidden.
    // A Session persistence failure fails the login (503): there is no
    // legacy net anymore for normal Staff authentication.
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
        staffId: staffPayload.staffId,
        role,
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
    return NextResponse.json({ success: true, role, staff: { id: staffPayload.staffId, name: staffPayload.name, role }, ...(tabCredential ? { tabCredential } : {}) }, { status: 200 });
  }

  // AUTH-ARCH-8F: no Staff record for this role means authentication fails.
  // The former SystemAuth bootstrap fallback (shared role PIN, legacy-only
  // session) is retired: Staff is the sole credential authority and missing
  // accounts are never auto-created. Provisioning belongs to authorized
  // Staff Management.

  return NextResponse.json({ success: false, message: "Invalid PIN" }, { status: 401 });
}

export const POST = withApi(handler);
