// Canonical server-side authentication resolver — AUTH-ARCH-4, hardened ARCH-6,
// tab-scoped ARCH-11, legacy-retired ARCH-8F.
//
// SERVER-ONLY. Single authority used by requireAuth (API routes),
// getPortalSession (layouts), assertManager (Server Actions), and the
// manager staff PIN-reset guard. Do not implement a second algorithm.
//
// AUTHORITY RULE:
//   tab credential OR __Host-bono_session -> Session.sessionId or
//   Session.tabTokenHash -> Session.staffId -> Staff.findById() ->
//   Staff.isActive + Staff.role (LIVE) -> policy/allowedRoles -> allow/deny.
// Session.roleSnapshot is audit/metadata ONLY and never authorizes.
// Cookie role, client role, body role, and localStorage role never authorize.
//
// PRECEDENCE (deterministic):
//  1. Tab credential present (any non-empty X-Bono-Tab-Session) -> tab path
//     ONLY. The tab explicitly names its own Session; shared cookies are
//     ignored for identity. Invalid/revoked tab credentials REJECT — no
//     fallback of any kind.
//  2. New cookie present (any non-empty value) -> server-session path ONLY.
//     Revoked/expired/malformed new sessions REJECT with stable codes.
//
// AUTH-ARCH-8F: the legacy bono_sess HMAC path is retired. There is no
// legacy fallback, no sliding HMAC refresh, and no Bearer transport.
// A request bearing only a legacy cookie receives 401 and must re-login
// through Staff authentication.
//
// FAIL-CLOSED: credential present + DB unreachable -> 503 (never
// authenticated, never downgraded to 401).
//
// SECURITY: never log session IDs, cookies, or PINs.

import { NEW_SESSION_COOKIE, isOpaqueSessionValue } from "./serverSessionCookies.js";
import { isSessionTimeValid } from "./sessionStore.js";

// AUTH-ARCH-11: narrowly scoped tab-credential transport. This header carries
// ONLY per-tab operational session credentials (never legacy HMAC, never
// generic bearer tokens). It is accepted solely with server-side Session
// validation below; it is never logged and never appears in URLs.
export const TAB_SESSION_HEADER = "x-bono-tab-session";

// Extract a raw tab credential from request headers. Returns the verbatim
// value (even if malformed) so present-but-invalid credentials reject
// WITHOUT cookie fallback — same fail-closed rule as the new cookie.
export function parseTabCredential(headers) {
  try {
    const get = headers?.get?.bind(headers);
    if (typeof get !== "function") return null;
    const v = get(TAB_SESSION_HEADER) || get("X-Bono-Tab-Session");
    if (!v || typeof v !== "string") return null;
    const trimmed = v.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function dbUnavailable() {
  return { ok: false, status: 503, error: "Database connection error. Please retry shortly." };
}

// Pure: extract the canonical session ID from the raw Cookie header. The
// value is returned verbatim (even if malformed) so the engine can reject
// present-but-invalid cookies WITHOUT any fallback. AUTH-ARCH-8F: legacy
// bono_sess is no longer parsed — it authenticates nothing.
export function parseAuthCookies(cookieHeader) {
  let newSessionId = null;
  const cookies = typeof cookieHeader === "string" ? cookieHeader : "";
  const newMatch = /(?:^|;\s*)__Host-bono_session=([^;]+)/.exec(cookies);
  if (newMatch) {
    try {
      const v = decodeURIComponent(newMatch[1].trim());
      if (v) newSessionId = v;
    } catch {
      // Undecodable cookie value counts as present-but-invalid (no fallback).
      newSessionId = "invalid";
    }
  }
  return { newSessionId };
}

function checkAllowedRoles(liveRole, allowedRoles) {
  if (!allowedRoles || allowedRoles.length === 0) return null;
  const allowed = allowedRoles.map((r) => String(r).toUpperCase());
  if (!allowed.includes(String(liveRole).toUpperCase())) {
    return { ok: false, status: 403, error: `Forbidden: requires ${allowed.join("/")} role` };
  }
  return null;
}

// Shared authority tail: a resolved Session row -> live Staff -> payload.
// `connectProvider` is async () => conn (lets tests inject stub connections).
// Used identically by the cookie path and the AUTH-ARCH-11 tab path:
// roleSnapshot is never authoritative; only live Staff.isActive/role decide.
async function resolveLiveStaff(conn, session, allowedRoles, { authMethod, touchSessionId }) {
  if (!session) {
    return { ok: false, status: 401, error: "Invalid or expired session", code: "SESSION_EXPIRED" };
  }
  if (session.revokedAt) {
    return { ok: false, status: 401, error: "Your session is no longer valid. Please sign in again.", code: "SESSION_REVOKED" };
  }
  const time = isSessionTimeValid(session);
  if (!time.ok) {
    return {
      ok: false,
      status: 401,
      error:
        time.reason === "IDLE_EXPIRED"
          ? "Your session has expired due to inactivity. Please sign in again."
          : "Invalid or expired session",
      code: "SESSION_EXPIRED",
    };
  }
  // LIVE authority: role comes from Staff, never from roleSnapshot.
  let staff = null;
  try {
    const { getStaffModel } = await import("./models/Staff.js");
    staff = await getStaffModel(conn).findById(session.staffId).select("name role waiterNumber isActive").lean();
  } catch {
    return dbUnavailable();
  }
  if (!staff || staff.isActive === false) {
    return { ok: false, status: 401, error: "Account disabled. Please contact manager.", code: "ACCOUNT_DISABLED" };
  }
  const liveRole = String(staff.role).toUpperCase();
  // Sliding touch (internally throttled). Non-fatal: auth is established.
  if (touchSessionId) {
    try {
      const { touchSession } = await import("./sessionStore.js");
      await touchSession(conn, touchSessionId);
    } catch {}
  }
  const roleCheck = checkAllowedRoles(liveRole, allowedRoles);
  if (roleCheck) return roleCheck;
  // Response contract (preserves legacy fields callers rely on).
  const payload = {
    staffId: String(staff._id),
    role: liveRole,
    name: staff.name,
    staffName: staff.name,
    waiterNumber:
      liveRole === "WAITER" &&
      Number.isInteger(staff.waiterNumber) &&
      staff.waiterNumber >= 1 &&
      staff.waiterNumber <= 10
        ? staff.waiterNumber
        : null,
  };
  if (liveRole === "WAITER") payload.waiterName = staff.name;
  return { ok: true, payload, authMethod };
}

// Server-session path: opaque cookie ID -> Session row -> shared authority.
async function authenticateViaServerSession(connectProvider, newSessionId, allowedRoles) {
  if (!isOpaqueSessionValue(newSessionId)) {
    return { ok: false, status: 401, error: "Invalid or expired session", code: "SESSION_INVALID" };
  }
  let conn;
  try {
    conn = await connectProvider();
  } catch {
    return dbUnavailable();
  }
  let session = null;
  try {
    const { getSessionModel } = await import("./models/Session.js");
    session = await getSessionModel(conn).findOne({ sessionId: newSessionId }).lean();
  } catch {
    return dbUnavailable();
  }
  return resolveLiveStaff(conn, session, allowedRoles, { authMethod: "server", touchSessionId: newSessionId });
}

// AUTH-ARCH-11 tab path: raw tab credential -> hashed lookup -> Session row
// -> shared authority. Present-but-malformed credentials reject with
// SESSION_INVALID and never fall back to cookies.
async function authenticateViaTabSession(connectProvider, rawCredential, allowedRoles) {
  if (!isOpaqueSessionValue(rawCredential)) {
    return { ok: false, status: 401, error: "Invalid or expired session", code: "SESSION_INVALID" };
  }
  let conn;
  try {
    conn = await connectProvider();
  } catch {
    return dbUnavailable();
  }
  let session = null;
  try {
    const { getSessionByTabCredential } = await import("./sessionStore.js");
    session = await getSessionByTabCredential(conn, rawCredential);
  } catch {
    return dbUnavailable();
  }
  if (!session) {
    return { ok: false, status: 401, error: "Invalid or expired session", code: "SESSION_EXPIRED" };
  }
  return resolveLiveStaff(conn, session, allowedRoles, { authMethod: "tab", touchSessionId: session.sessionId });
}

// Canonical entry: deterministic precedence (tab credential, then the
// canonical session cookie). AUTH-ARCH-8F: no legacy fallback — a request
// bearing only a legacy cookie (or nothing) receives 401 and must re-login
// through Staff authentication.
export async function authenticateRequest({
  connectProvider,
  tabCredential,
  newSessionId,
  allowedRoles,
}) {
  if (tabCredential) {
    return authenticateViaTabSession(connectProvider, tabCredential, allowedRoles);
  }
  if (newSessionId) {
    return authenticateViaServerSession(connectProvider, newSessionId, allowedRoles);
  }
  return { ok: false, status: 401, error: "Authentication required" };
}

// Server-Action adapter: resolve a raw tab credential (e.g. carried in a
// FormData field, since Server Actions receive no Request headers) through
// the canonical engine. Returns the live payload or null. No DB is touched
// for empty input.
export async function resolveTabSession(rawCredential, allowedRoles) {
  if (!rawCredential || typeof rawCredential !== "string" || !rawCredential.trim()) return null;
  try {
    const { connectToDatabase } = await import("./mongodb.js");
    const res = await authenticateViaTabSession(connectToDatabase, rawCredential.trim(), allowedRoles);
    return res.ok ? res.payload : null;
  } catch {
    return null;
  }
}

// Layout / Server Action adapter: reads the canonical session cookie from a
// next/headers store, resolves via the canonical engine, returns the live
// payload or null. No DB is touched when the cookie is absent. AUTH-ARCH-8F:
// legacy bono_sess is never consulted.
export async function getLiveSessionFromCookies(store, allowedRoles) {
  const newSessionId = store.get(NEW_SESSION_COOKIE)?.value || null;
  if (!newSessionId) return null;
  try {
    const { connectToDatabase } = await import("./mongodb.js");
    const res = await authenticateRequest({
      connectProvider: connectToDatabase,
      newSessionId,
      allowedRoles,
    });
    return res.ok ? res.payload : null;
  } catch {
    return null;
  }
}
