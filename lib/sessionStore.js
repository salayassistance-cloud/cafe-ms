// BONO server-side session primitives — AUTH-ARCH-2 foundation.
//
// SERVER-ONLY. Never import from client components. Not yet wired to
// login-staff / verify-pin / logout / requireAuth / getPortalSession —
// those keep their current HMAC behavior unchanged until AUTH-ARCH-3/4.
//
// LIVE-ROLE PRINCIPLE (repeated so future callers cannot miss it):
//   sessionId -> staffId -> Staff.findById() -> Staff.isActive + Staff.role
//   (LIVE, re-read per request) -> policy.can(...) -> allow/deny.
// `roleSnapshot` is audit/metadata ONLY. Cookie role, session roleSnapshot,
// client-supplied role, and localStorage role MUST NEVER be treated as
// authorization authority. AUTH-ARCH-2-11 tests this conceptually.
//
// SECURITY:
// - Never log raw sessionId / cookies / tokens / PINs / AUTH_SECRET.
//   Use sessionFingerprint() (short SHA-256 hex) for diagnostics.
// - Session IDs are opaque 256-bit crypto-random base64url strings.
// - IP hash is advisory only; never invalidate on IP change.
// - Idle refresh MUST NEVER extend absolute expiresAt (tested).

import crypto from "crypto";
import { SESSION_ROLES, SESSION_REVOKE_REASONS } from "./models/Session.js";

// ---- Centralized lifetimes (single source; change here only) ----
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000; // ~8h POS shift (binding)
export const SESSION_IDLE_MS = 30 * 60 * 1000; // ~30min activity signal (written but NEVER enforced — restaurant policy: no idle logout)
// Throttle for AUTH-ARCH-4: skip DB touch if last touch is fresher than this.
export const SESSION_TOUCH_THROTTLE_MS = 60 * 1000; // 60s
// AUTH-ARCH-11: tab heartbeat cadence. Rationale: 6 heartbeats fit inside one
// 30-minute idle window, so several consecutive failures still cannot idle
// out an open tab; one tiny POST per tab per interval is negligible load.
export const TAB_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5min

export const SESSION_ID_BYTES = 32; // 256 bits

function assertServerOnly() {
  if (typeof window !== "undefined") {
    throw new Error("lib/sessionStore is server-only");
  }
}

// ---- Session ID generation (PART 4) ----
export function generateSessionId() {
  assertServerOnly();
  // crypto.randomBytes is CSPRNG. base64url of 32 bytes = 43 chars, ~256 bits.
  // Meaningless by itself: no staffId/role/username/time/counter input.
  return crypto.randomBytes(SESSION_ID_BYTES).toString("base64url");
}

// ---- Logging-safe helpers (PART 10) ----
export function sessionFingerprint(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return "none";
  return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
}

export function hashRequestMeta(value) {
  if (!value || typeof value !== "string") return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

// ---- Pure validators (DB-free; used by tests + future requireAuth) ----
export function isValidRoleSnapshot(role) {
  return SESSION_ROLES.includes(String(role || "").toUpperCase());
}

export function isSessionTimeValid(session, now = Date.now()) {
  if (!session || typeof session !== "object") return { ok: false, reason: "NO_SESSION" };
  if (session.revokedAt) return { ok: false, reason: session.revokeReason || "REVOKED" };
  const t = Number(now);
  if (session.expiresAt && t > Number(new Date(session.expiresAt).getTime())) {
    return { ok: false, reason: "EXPIRED" };
  }
  // Restaurant station policy: NO idle logout. idleExpiresAt is still written
  // as a last-activity signal but is NEVER an validity decision — an
  // operational tab stays authenticated for the full 8-hour absolute window
  // regardless of interaction. Only explicit logout/revocation/disable or the
  // absolute expiry ends a session early.
  return { ok: true };
}

// Full conceptual validation incl. live Staff state (PART 5).
// `staff` is the LIVE Staff doc (isActive + role); roleSnapshot is ignored
// for the decision and only reported for audit.
export function isSessionValid(session, staff, now = Date.now()) {
  const time = isSessionTimeValid(session, now);
  if (!time.ok) return time;
  if (!staff) return { ok: false, reason: "STAFF_NOT_FOUND" };
  if (staff.isActive === false) return { ok: false, reason: "ACCOUNT_DISABLED" };
  return {
    ok: true,
    // Caller MUST authorize against staff.role (live), not roleSnapshot.
    liveRole: staff.role ? String(staff.role).toUpperCase() : null,
    roleSnapshot: session.roleSnapshot || null,
  };
}

// Build an unsaved session document object (pure; no DB I/O). Lets
// AUTH-ARCH-3 construct rows without touching login code today.
export function buildSessionDoc({ staffId, role, userAgent, ip, now = Date.now() } = {}) {
  assertServerOnly();
  if (!staffId) throw new Error("staffId required");
  const snapshot = String(role || "").toUpperCase();
  if (!isValidRoleSnapshot(snapshot)) throw new Error(`Invalid roleSnapshot: ${role}`);
  const t = Number(now);
  return {
    sessionId: generateSessionId(),
    staffId,
    roleSnapshot: snapshot,
    lastSeenAt: new Date(t),
    expiresAt: new Date(t + SESSION_ABSOLUTE_MS),
    idleExpiresAt: new Date(t + SESSION_IDLE_MS),
    version: 1,
    userAgentHash: userAgent ? hashRequestMeta(String(userAgent)) : null,
    ipHash: ip ? hashRequestMeta(String(ip)) : null,
    revokedAt: null,
    revokeReason: null,
  };
}

// Compute a touch update WITHOUT extending absolute expiry (PART 9).
// Returns { lastSeenAt, idleExpiresAt } or null when throttled.
export function computeTouchUpdate(session, now = Date.now()) {
  const t = Number(now);
  const lastSeen = session?.lastSeenAt ? Number(new Date(session.lastSeenAt).getTime()) : 0;
  if (t - lastSeen < SESSION_TOUCH_THROTTLE_MS) return null; // throttled
  const absolute = Number(new Date(session.expiresAt).getTime());
  // Idle window slides, but clamps to absolute expiry — never beyond it.
  const idle = Math.min(t + SESSION_IDLE_MS, absolute);
  return { lastSeenAt: new Date(t), idleExpiresAt: new Date(idle) };
}

// ---- DB-backed primitives (unused until AUTH-ARCH-3/4; no caller yet) ----
async function sessionModelFor(conn) {
  const { getSessionModel } = await import("./models/Session.js");
  return getSessionModel(conn);
}

function normalizeReason(reason) {
  const r = String(reason || "").toUpperCase();
  return SESSION_REVOKE_REASONS.includes(r) ? r : "SECURITY";
}

export async function createSession(conn, { staffId, role, userAgent, ip, now } = {}) {
  const Session = await sessionModelFor(conn);
  const doc = buildSessionDoc({ staffId, role, userAgent, ip, now });
  return Session.create(doc);
}

export async function getSession(conn, sessionId) {
  if (!sessionId || typeof sessionId !== "string") return null;
  const Session = await sessionModelFor(conn);
  return Session.findOne({ sessionId }).lean();
}

export async function touchSession(conn, sessionId, now = Date.now()) {
  const Session = await sessionModelFor(conn);
  const current = await Session.findOne({ sessionId }).select("_id lastSeenAt expiresAt idleExpiresAt revokedAt");
  if (!current || current.revokedAt) return null;
  const update = computeTouchUpdate(current, now);
  if (!update) return current; // throttled — no write
  return Session.findByIdAndUpdate(current._id, { $set: update }, { new: true }).lean();
}

export async function revokeSession(conn, sessionId, reason = "LOGOUT") {
  const Session = await sessionModelFor(conn);
  return Session.findOneAndUpdate(
    { sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: normalizeReason(reason) } },
    { new: true }
  ).lean();
}

export async function revokeAllStaffSessions(conn, staffId, reason = "SECURITY") {
  const Session = await sessionModelFor(conn);
  return Session.updateMany(
    { staffId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: normalizeReason(reason) } }
  );
}

export async function revokeRoleSessions(conn, role, reason = "SECURITY") {
  // Revokes by LIVE staff role would need a Staff join; this revokes by the
  // audit snapshot for emergency role-wide invalidation. Future ARCH-4
  // prefers revoke-by-staffId loops over live role queries.
  const snapshot = String(role || "").toUpperCase();
  if (!isValidRoleSnapshot(snapshot)) throw new Error(`Invalid role: ${role}`);
  const Session = await sessionModelFor(conn);
  return Session.updateMany(
    { roleSnapshot: snapshot, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: normalizeReason(reason) } }
  );
}

export async function rotateSession(conn, oldSessionId, { userAgent, ip, now } = {}) {
  const Session = await sessionModelFor(conn);
  const current = await Session.findOne({ sessionId: oldSessionId });
  if (!current || current.revokedAt) return null;
  current.revokedAt = new Date();
  current.revokeReason = "ROTATED";
  await current.save();
  const fresh = buildSessionDoc({
    staffId: current.staffId,
    role: current.roleSnapshot,
    userAgent,
    ip,
    now,
  });
  // Preserve absolute expiry across rotation: rotation is not lifetime extension.
  fresh.expiresAt = current.expiresAt;
  // Re-clamp idle to the preserved absolute expiry.
  const t = Number(now ?? Date.now());
  fresh.idleExpiresAt = new Date(Math.min(t + SESSION_IDLE_MS, Number(new Date(current.expiresAt).getTime())));
  return Session.create(fresh);
}

// ---- AUTH-ARCH-11: tab-scoped operational credentials ----
//
// A tab credential is a second, independent access path to ONE Session row:
// the browser cookie addresses the row by sessionId, the tab addresses it
// by tabTokenHash (SHA-256 of a fresh 256-bit random value). The raw value
// exists only in the issuing tab's JS memory and is returned exactly once
// at login; the server stores only the hash. Same Staff authority, same
// revocation, same TTL cleanup — no new session semantics.
//
// Liveness model ("no idle timeout while the tab is open"): an open tab
// heartbeats every TAB_HEARTBEAT_INTERVAL_MS; each heartbeat revalidates
// Staff.isActive and records activity (lastSeenAt/idleExpiresAt) WITHOUT
// moving the 8h absolute deadline. Abandoned tabs stop heartbeating, so
// their rows expire on expiresAt and the TTL index reclaims them. Nothing
// is immortal; revocation is immediate.

// Fresh tab credential (256-bit CSPRNG, base64url). Meaningless by itself.
export function generateTabCredential() {
  assertServerOnly();
  return crypto.randomBytes(SESSION_ID_BYTES).toString("base64url");
}

// SHA-256 hex of a raw tab credential — the only form ever stored/compared.
export function hashTabCredential(raw) {
  if (!raw || typeof raw !== "string") return null;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Bind a fresh tab credential to an existing valid Session row. Returns the
// RAW credential (hand to the issuing tab exactly once) or null when the
// row is missing/revoked. Never touches other sessions.
export async function attachTabCredential(conn, sessionId) {
  const Session = await sessionModelFor(conn);
  const current = await Session.findOne({ sessionId }).select("_id revokedAt");
  if (!current || current.revokedAt) return null;
  const raw = generateTabCredential();
  await Session.updateOne({ _id: current._id }, { $set: { tabTokenHash: hashTabCredential(raw) } });
  return raw;
}

// Lookup a Session row by RAW tab credential (hashed before query).
export async function getSessionByTabCredential(conn, raw) {
  const hash = hashTabCredential(raw);
  if (!hash) return null;
  const Session = await sessionModelFor(conn);
  return Session.findOne({ tabTokenHash: hash }).lean();
}

// Revoke exactly the Session bound to a raw tab credential (tab-scoped
// logout). Other sessions — including other tabs of the same Staff — are
// untouched. Returns the revoked row or null. Idempotent.
export async function revokeSessionByTabCredential(conn, raw, reason = "LOGOUT") {
  const hash = hashTabCredential(raw);
  if (!hash) return null;
  const Session = await sessionModelFor(conn);
  return Session.findOneAndUpdate(
    { tabTokenHash: hash, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: normalizeReason(reason) } },
    { new: true }
  ).lean();
}

// Tab heartbeat: revalidate + record liveness for an ACTIVE tab.
// - Revoked/missing/expired session -> { ok:false, code } (no write, no fallback).
// - Disabled/missing Staff -> { ok:false, code:'ACCOUNT_DISABLED' }.
// - Otherwise refreshes lastSeenAt/idleExpiresAt and returns { ok:true }.
//   expiresAt (8h absolute) is NEVER extended here: an expired session stays
//   expired and every tab re-authenticates after 8 hours. Abandoned rows
//   expire on their absolute deadline and TTL reclaims them.
export async function refreshTabSession(conn, raw, now = Date.now()) {
  const Session = await sessionModelFor(conn);
  const session = await getSessionByTabCredential(conn, raw);
  if (!session) return { ok: false, code: "SESSION_EXPIRED" };
  if (session.revokedAt) return { ok: false, code: "SESSION_REVOKED" };
  const t = Number(now);
  if (session.expiresAt && t > Number(new Date(session.expiresAt).getTime())) {
    return { ok: false, code: "SESSION_EXPIRED" };
  }
  try {
    const { getStaffModel } = await import("./models/Staff.js");
    const staff = await getStaffModel(conn).findById(session.staffId).select("isActive").lean();
    if (!staff || staff.isActive === false) return { ok: false, code: "ACCOUNT_DISABLED" };
  } catch {
    return { ok: false, code: "DB_UNAVAILABLE" };
  }
  const update = {
    lastSeenAt: new Date(t),
    idleExpiresAt: new Date(t + SESSION_IDLE_MS),
  };
  await Session.updateOne({ _id: session._id }, { $set: update });
  return { ok: true };
}
