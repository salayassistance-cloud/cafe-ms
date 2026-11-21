import crypto from "crypto";

import {
  HOTEL_SESSION_ABSOLUTE_MS,
  HOTEL_SESSION_COOKIE,
  HOTEL_SESSION_IDLE_MS,
  HOTEL_SESSION_TOKEN_BYTES,
  HOTEL_SESSION_TOUCH_THROTTLE_MS,
} from "../constants.js";
import { requireHotelSessionSecret } from "../config.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
} from "../errors.js";
import { getHotelSessionModel } from "../models/hotelSession.js";
import { getHotelUserModel, toSafeHotelUser } from "../models/hotelUser.js";
import {
  getHotelRequestAuditMeta,
  HOTEL_AUDIT_ACTIONS,
  safeRecordHotelAudit,
} from "../audit.js";
import { normalizeHotelRole } from "./authorization.js";
import {
  deriveHotelSessionCsrfToken,
  generateHotelCsrfToken,
  hashHotelCsrfToken,
  verifyDerivedHotelSessionCsrfToken,
  verifyHotelCsrfToken,
} from "./csrf.js";

// Hotel session lifecycle.
//
// The browser holds an opaque 256-bit random token in a Hotel-only cookie.
// MongoDB stores only HMAC-SHA256(HOTEL_SESSION_SECRET, token). The session
// row is the revocation authority; the live HotelUser is the role authority.
//
// This module deliberately does not import any POS session, cookie, auth, or
// database module.

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HMAC_DOMAIN = "bono-hotel-session-v1";
const VALID_REVOCATIONS = new Set([
  "LOGOUT",
  "ROTATED",
  "ACCOUNT_DISABLED",
  "ROLE_CHANGED",
  "SECURITY",
  "EXPIRED",
]);

function assertServerOnly() {
  if (typeof window !== "undefined") {
    throw new Error("Hotel session helpers are server-only");
  }
}

export function isHotelSessionConfigured() {
  try {
    requireHotelSessionSecret();
    return true;
  } catch {
    return false;
  }
}

export function assertHotelSessionConfigured() {
  requireHotelSessionSecret();
  return true;
}

export function generateHotelSessionToken() {
  assertServerOnly();
  return crypto.randomBytes(HOTEL_SESSION_TOKEN_BYTES).toString("base64url");
}

export function isHotelSessionToken(value) {
  return typeof value === "string" && TOKEN_RE.test(value);
}

// Pure cookie-header parser. Kept here so Route Handler service code does not
// need to import next/headers (and so it remains DB-free testable).
export function parseHotelSessionCookieHeader(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) {
    return null;
  }
  const match = new RegExp(
    `(?:^|;\\s*)${HOTEL_SESSION_COOKIE}=([^;]*)`
  ).exec(cookieHeader);
  if (!match) return null;

  let value = null;
  try {
    value = decodeURIComponent(match[1].trim());
  } catch {
    return null;
  }
  return isHotelSessionToken(value) ? value : null;
}

export function hashHotelSessionToken(rawToken) {
  assertServerOnly();
  if (!isHotelSessionToken(rawToken)) {
    throw new HotelApiError({
      code: HOTEL_ERROR_CODES.INVALID_SESSION,
      message: "Invalid session",
      status: 401,
      expose: true,
    });
  }
  return crypto
    .createHmac("sha256", requireHotelSessionSecret())
    .update(`${HMAC_DOMAIN}\u0000${rawToken}`)
    .digest("hex");
}

export function hotelSessionFingerprint(rawToken) {
  if (!isHotelSessionToken(rawToken)) return "none";
  return crypto.createHash("sha256").update(rawToken).digest("hex").slice(0, 12);
}

export function isHotelSessionTimeValid(session, now = Date.now()) {
  if (!session || typeof session !== "object") {
    return { ok: false, code: HOTEL_ERROR_CODES.INVALID_SESSION, reason: "NO_SESSION" };
  }
  if (session.revokedAt) {
    return {
      ok: false,
      code: HOTEL_ERROR_CODES.INVALID_SESSION,
      reason: session.revokeReason || "REVOKED",
    };
  }

  const current = Number(now);
  const absolute = new Date(session.expiresAt).getTime();
  const idle = new Date(session.idleExpiresAt).getTime();
  if (!Number.isFinite(current) || !Number.isFinite(absolute) || !Number.isFinite(idle)) {
    return { ok: false, code: HOTEL_ERROR_CODES.INVALID_SESSION, reason: "INVALID_TIMES" };
  }
  if (current >= absolute) {
    return { ok: false, code: HOTEL_ERROR_CODES.SESSION_EXPIRED, reason: "EXPIRED" };
  }
  if (current >= idle) {
    return { ok: false, code: HOTEL_ERROR_CODES.SESSION_EXPIRED, reason: "IDLE_TIMEOUT" };
  }
  return { ok: true };
}

export function isHotelSessionValid(session, liveUser, now = Date.now()) {
  const time = isHotelSessionTimeValid(session, now);
  if (!time.ok) return time;

  if (!liveUser) {
    return { ok: false, code: HOTEL_ERROR_CODES.INVALID_SESSION, reason: "USER_NOT_FOUND" };
  }
  if (liveUser.isActive !== true) {
    return {
      ok: false,
      code: HOTEL_ERROR_CODES.ACCOUNT_DISABLED,
      reason: "ACCOUNT_DISABLED",
    };
  }

  // Phase 3F / E-01: a credential change invalidates sessions issued before
  // it, even if a bulk revocation write failed. Uses existing HotelSession
  // `createdAt` and HotelUser `pinSetAt`; no schema/deployment change needed.
  if (liveUser.pinSetAt && session.createdAt) {
    const pinSet = new Date(liveUser.pinSetAt).getTime();
    const issued = new Date(session.createdAt).getTime();
    if (Number.isFinite(pinSet) && Number.isFinite(issued) && pinSet > issued) {
      return {
        ok: false,
        code: HOTEL_ERROR_CODES.INVALID_SESSION,
        reason: "CREDENTIAL_CHANGED",
      };
    }
  }

  const liveRole = normalizeHotelRole(liveUser.role);
  if (!liveRole) {
    return { ok: false, code: HOTEL_ERROR_CODES.INVALID_SESSION, reason: "INVALID_ROLE" };
  }
  if (session.roleSnapshot && session.roleSnapshot !== liveRole) {
    return {
      ok: false,
      code: HOTEL_ERROR_CODES.INVALID_SESSION,
      reason: "ROLE_CHANGED",
    };
  }

  return {
    ok: true,
    liveRole,
    roleSnapshot: session.roleSnapshot ?? null,
  };
}

export function computeHotelSessionTouch(session, now = Date.now()) {
  if (!session) return null;
  const current = Number(now);
  const lastSeen = new Date(session.lastSeenAt).getTime();
  const absolute = new Date(session.expiresAt).getTime();
  if (!Number.isFinite(current) || !Number.isFinite(lastSeen) || !Number.isFinite(absolute)) {
    return null;
  }
  if (current - lastSeen < HOTEL_SESSION_TOUCH_THROTTLE_MS) return null;

  return {
    lastSeenAt: new Date(current),
    idleExpiresAt: new Date(
      Math.min(current + HOTEL_SESSION_IDLE_MS, absolute)
    ),
  };
}

export function buildHotelSessionDoc({
  hotelUserId,
  role,
  rawToken,
  csrfToken = null,
  request = null,
  now = Date.now(),
} = {}) {
  assertServerOnly();
  if (!hotelUserId) throw new Error("hotelUserId is required");

  const token = rawToken || generateHotelSessionToken();
  const csrf = csrfToken || generateHotelCsrfToken();
  const normalizedRole = normalizeHotelRole(role);
  if (!normalizedRole) throw new Error("A valid Hotel role is required");

  const current = Number(now);
  const requestMeta = getHotelRequestAuditMeta(request);

  return {
    hotelUserId,
    tokenHash: hashHotelSessionToken(token),
    csrfHash: hashHotelCsrfToken(csrf),
    roleSnapshot: normalizedRole,
    lastSeenAt: new Date(current),
    expiresAt: new Date(current + HOTEL_SESSION_ABSOLUTE_MS),
    idleExpiresAt: new Date(current + HOTEL_SESSION_IDLE_MS),
    revokedAt: null,
    revokeReason: null,
    userAgentHash: requestMeta.userAgentHash,
    ipHash: requestMeta.ipHash,
  };
}

export async function createHotelSession(
  connection,
  { hotelUserId, role, request = null, now = Date.now() } = {}
) {
  assertHotelSessionConfigured();
  const rawToken = generateHotelSessionToken();
  // Deterministic per session: reloads and concurrent clients (multiple tabs,
  // StrictMode double mount) all receive the same token, so one bootstrap can
  // never invalidate another client's CSRF token.
  const csrfToken = deriveHotelSessionCsrfToken(rawToken);
  if (!csrfToken) {
    // Unreachable for a generated session token; fail closed rather than
    // returning a token that was never bound to the stored hash.
    throw new Error("Unable to derive the Hotel session CSRF token");
  }
  const doc = buildHotelSessionDoc({
    hotelUserId,
    role,
    rawToken,
    csrfToken,
    request,
    now,
  });
  const HotelSession = getHotelSessionModel(connection);
  const session = await HotelSession.create(doc);
  return { token: rawToken, csrfToken, session };
}

// Accept the stored hash (legacy random tokens issued before deterministic
// derivation) or the token derived from this session's opaque cookie token.
// Both are secret-keyed HMACs bound to one session; a token minted for another
// session, or an arbitrary/stale token, matches neither.
export function verifyHotelSessionCsrf(
  session,
  rawCsrfToken,
  rawSessionToken = null
) {
  if (!session || typeof session !== "object") return false;
  if (verifyHotelCsrfToken(rawCsrfToken, session.csrfHash)) return true;
  if (!rawSessionToken) return false;
  return verifyDerivedHotelSessionCsrfToken(rawCsrfToken, rawSessionToken);
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

async function revokeForSecurity(connection, session, reason) {
  const HotelSession = getHotelSessionModel(connection);
  await HotelSession.updateOne(
    { _id: session._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: reason } }
  ).catch(() => {});
}

export async function resolveHotelSession(
  connection,
  rawToken,
  { touch = true, now = Date.now() } = {}
) {
  assertHotelSessionConfigured();
  if (!isHotelSessionToken(rawToken)) {
    return fail(HOTEL_ERROR_CODES.INVALID_SESSION, "MALFORMED_TOKEN");
  }

  const tokenHash = hashHotelSessionToken(rawToken);
  const HotelSession = getHotelSessionModel(connection);
  const session = await HotelSession.findOne({ tokenHash })
    .select("+csrfHash")
    .lean();
  if (!session) {
    return fail(HOTEL_ERROR_CODES.INVALID_SESSION, "NOT_FOUND");
  }

  const time = isHotelSessionTimeValid(session, now);
  if (!time.ok) return time;

  const HotelUser = getHotelUserModel(connection);
  const liveUser = await HotelUser.findById(session.hotelUserId)
    .select("_id email name role isActive lastLoginAt pinSetAt")
    .lean();

  const validity = isHotelSessionValid(session, liveUser, now);
  if (!validity.ok) {
    if (validity.reason === "ACCOUNT_DISABLED") {
      await revokeForSecurity(connection, session, "ACCOUNT_DISABLED");
      await safeRecordHotelAudit(connection, {
        action: HOTEL_AUDIT_ACTIONS.AUTH_SESSION_REVOKED,
        outcome: "DENIED",
        actorUserId: session.hotelUserId,
        actorRole: session.roleSnapshot,
        entityType: "HotelSession",
        entityId: String(session._id),
        metadata: { reason: "ACCOUNT_DISABLED" },
      });
    } else if (validity.reason === "ROLE_CHANGED") {
      await revokeForSecurity(connection, session, "ROLE_CHANGED");
      await safeRecordHotelAudit(connection, {
        action: HOTEL_AUDIT_ACTIONS.AUTH_SESSION_REVOKED,
        outcome: "DENIED",
        actorUserId: session.hotelUserId,
        actorRole: session.roleSnapshot,
        entityType: "HotelSession",
        entityId: String(session._id),
        metadata: { reason: "ROLE_CHANGED" },
      });
    } else if (validity.reason === "CREDENTIAL_CHANGED") {
      await revokeForSecurity(connection, session, "SECURITY");
      await safeRecordHotelAudit(connection, {
        action: HOTEL_AUDIT_ACTIONS.AUTH_SESSION_REVOKED,
        outcome: "DENIED",
        actorUserId: session.hotelUserId,
        actorRole: session.roleSnapshot,
        entityType: "HotelSession",
        entityId: String(session._id),
        metadata: { reason: "CREDENTIAL_CHANGED" },
      });
    }
    return validity;
  }

  if (touch) {
    const update = computeHotelSessionTouch(session, now);
    if (update) {
      await HotelSession.updateOne(
        { _id: session._id, revokedAt: null },
        { $set: update }
      ).catch(() => {});
    }
  }

  return {
    ok: true,
    session,
    user: toSafeHotelUser(liveUser),
    role: validity.liveRole,
    roleSnapshot: validity.roleSnapshot,
  };
}

export async function revokeHotelSession(
  connection,
  rawToken,
  reason = "LOGOUT"
) {
  assertHotelSessionConfigured();
  if (!isHotelSessionToken(rawToken)) return false;

  const normalizedReason = VALID_REVOCATIONS.has(String(reason).toUpperCase())
    ? String(reason).toUpperCase()
    : "SECURITY";
  const HotelSession = getHotelSessionModel(connection);
  const result = await HotelSession.updateOne(
    {
      tokenHash: hashHotelSessionToken(rawToken),
      revokedAt: null,
    },
    {
      $set: {
        revokedAt: new Date(),
        revokeReason: normalizedReason,
      },
    }
  );
  return result.modifiedCount > 0;
}

export async function revokeAllHotelSessionsForUser(
  connection,
  hotelUserId,
  reason = "SECURITY"
) {
  if (!hotelUserId) return 0;
  const normalizedReason = VALID_REVOCATIONS.has(String(reason).toUpperCase())
    ? String(reason).toUpperCase()
    : "SECURITY";
  const HotelSession = getHotelSessionModel(connection);
  const result = await HotelSession.updateMany(
    { hotelUserId, revokedAt: null },
    {
      $set: {
        revokedAt: new Date(),
        revokeReason: normalizedReason,
      },
    }
  );
  return result.modifiedCount ?? 0;
}
