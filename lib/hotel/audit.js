// Hotel-only audit logging foundation.
//
// Best-effort writes must never break the primary operation. Any caller that
// requires an audit write to be atomic should use a transaction instead of
// `safeRecordHotelAudit`.

import crypto from "crypto";
import mongoose from "mongoose";

import {
  HOTEL_AUDIT_OUTCOMES,
} from "./constants.js";
import { getHotelAuditLogModel } from "./models/hotelAuditLog.js";
import { getTrustedHotelClientIp } from "./http/clientIp.js";
import { normalizeHotelRole } from "./auth/authorization.js";
import {
  HotelValidationError,
  redactSensitiveText,
} from "./errors.js";

export const HOTEL_AUDIT_ACTIONS = Object.freeze({
  AUTH_LOGIN_SUCCEEDED: "AUTH_LOGIN_SUCCEEDED",
  AUTH_LOGIN_FAILED: "AUTH_LOGIN_FAILED",
  AUTH_LOGOUT: "AUTH_LOGOUT",
  AUTH_SESSION_REVOKED: "AUTH_SESSION_REVOKED",
  AUTH_ACCESS_DENIED: "AUTH_ACCESS_DENIED",
  ROOM_TYPE_CREATED: "ROOM_TYPE_CREATED",
  ROOM_TYPE_UPDATED: "ROOM_TYPE_UPDATED",
  ROOM_TYPE_DEACTIVATED: "ROOM_TYPE_DEACTIVATED",
  ROOM_CREATED: "ROOM_CREATED",
  ROOM_UPDATED: "ROOM_UPDATED",
  ROOM_DEACTIVATED: "ROOM_DEACTIVATED",
  ROOM_STATUS_CHANGED: "ROOM_STATUS_CHANGED",
  GUEST_CREATED: "GUEST_CREATED",
  GUEST_UPDATED: "GUEST_UPDATED",
  GUEST_DEACTIVATED: "GUEST_DEACTIVATED",
  RESERVATION_CREATED: "RESERVATION_CREATED",
  RESERVATION_UPDATED: "RESERVATION_UPDATED",
  RESERVATION_CANCELLED: "RESERVATION_CANCELLED",
  RESERVATION_ROOM_ASSIGNED: "RESERVATION_ROOM_ASSIGNED",
  RESERVATION_CHECKED_IN: "RESERVATION_CHECKED_IN",
  RESERVATION_CHECKED_OUT: "RESERVATION_CHECKED_OUT",
  STAY_CHECKED_IN: "STAY_CHECKED_IN",
  STAY_CHECKED_OUT: "STAY_CHECKED_OUT",
  PAYMENT_RECORDED: "PAYMENT_RECORDED",
  PAYMENT_REPLAYED: "PAYMENT_REPLAYED",
  PAYMENT_REJECTED: "PAYMENT_REJECTED",
  PAYMENT_VOIDED: "PAYMENT_VOIDED",
  PAYMENT_VOID_REPLAYED: "PAYMENT_VOID_REPLAYED",
  FIRST_MANAGER_PROVISIONED: "FIRST_MANAGER_PROVISIONED",
  HOTEL_USER_CREDENTIALS_ROTATED: "HOTEL_USER_CREDENTIALS_ROTATED",
  // Phase 2 staff management + identity-scoped authentication.
  STAFF_CREATED: "STAFF_CREATED",
  STAFF_UPDATED: "STAFF_UPDATED",
  STAFF_PASSWORD_SET: "STAFF_PASSWORD_SET",
  STAFF_PASSWORD_RESET: "STAFF_PASSWORD_RESET",
  STAFF_PASSWORD_CHANGE_REJECTED: "STAFF_PASSWORD_CHANGE_REJECTED",
  STAFF_ACTIVATED: "STAFF_ACTIVATED",
  STAFF_DEACTIVATED: "STAFF_DEACTIVATED",
  STAFF_MANAGER_PROVISIONED: "STAFF_MANAGER_PROVISIONED",
  STAFF_LOGIN_LOCKED: "STAFF_LOGIN_LOCKED",
  STAFF_SELF_PASSWORD_CHANGED: "STAFF_SELF_PASSWORD_CHANGED",
});

const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_KEYS = 30;
const MAX_METADATA_ARRAY = 20;
const MAX_METADATA_STRING = 500;

// Phase 3F / E-18: deny PIN-related keys as well, including common hash and
// lifecycle variants. This is defense-in-depth; callers still pass only safe
// summaries, never credential material.
const FORBIDDEN_METADATA_KEY_RE =
  /(password|passwd|pwd|secret|token|cookie|authorization|credential|sessionid|mongodb|connectionstring|pin|pinhash|pinnumber|pincode|pincodehash)/i;

const ACTION_RE = /^[A-Z][A-Z0-9_.:-]{2,79}$/;

export function hashAuditValue(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return crypto.createHash("sha256").update(value).digest("hex");
}

function getHeader(request, name) {
  try {
    const value = request?.headers?.get?.(name);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

export function getHotelRequestAuditMeta(request) {
  // Phase 3F / E-03: use the SAME trusted source as rate limiting. Client-
  // supplied forwarding headers are never recorded, hashed or trusted.
  const ip = getTrustedHotelClientIp(request) || "";
  const userAgent = getHeader(request, "user-agent");

  return {
    ipHash: ip ? hashAuditValue(ip.slice(0, 100)) : null,
    userAgentHash: userAgent ? hashAuditValue(userAgent.slice(0, 500)) : null,
  };
}

export function sanitizeHotelAuditMetadata(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return null;
  if (typeof value === "string") {
    return redactSensitiveText(value.slice(0, MAX_METADATA_STRING));
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (depth >= MAX_METADATA_DEPTH) return "[truncated]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_METADATA_ARRAY)
      .map((entry) => sanitizeHotelAuditMetadata(entry, depth + 1, seen));
  }

  const output = {};
  const entries = Object.entries(value)
    .filter(([key, entry]) => {
      if (FORBIDDEN_METADATA_KEY_RE.test(key)) return false;
      if (key.startsWith("$") || key.startsWith("__")) return false;
      return entry !== undefined;
    })
    .slice(0, MAX_METADATA_KEYS);

  for (const [key, entry] of entries) {
    output[key] = sanitizeHotelAuditMetadata(entry, depth + 1, seen);
  }
  return output;
}

function optionalText(value, field, maxLength) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new HotelValidationError({ [field]: `${field} must be a string` });
  }
  const text = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function normalizeActorId(value) {
  if (value == null || value === "") return null;
  const id = String(value);
  return mongoose.isValidObjectId(id) ? id : null;
}

export async function recordHotelAudit(connection, event = {}) {
  const {
    action,
    outcome,
    actorUserId = null,
    actorRole = null,
    entityType = null,
    entityId = null,
    metadata = {},
    request = null,
    requestId = null,
  } = event;

  const normalizedAction = String(action ?? "").trim();
  if (!ACTION_RE.test(normalizedAction)) {
    throw new HotelValidationError({
      action: "action must be a stable uppercase audit action",
    });
  }

  const normalizedOutcome = String(outcome ?? "").trim().toUpperCase();
  if (!HOTEL_AUDIT_OUTCOMES.includes(normalizedOutcome)) {
    throw new HotelValidationError({
      outcome: `outcome must be one of ${HOTEL_AUDIT_OUTCOMES.join(", ")}`,
    });
  }

  const normalizedRole =
    actorRole == null ? null : normalizeHotelRole(actorRole);
  if (actorRole != null && !normalizedRole) {
    throw new HotelValidationError({ actorRole: "actorRole is invalid" });
  }

  const requestMeta = getHotelRequestAuditMeta(request);
  const HotelAuditLog = getHotelAuditLogModel(connection);

  return HotelAuditLog.create({
    action: normalizedAction,
    outcome: normalizedOutcome,
    actorUserId: normalizeActorId(actorUserId),
    actorRole: normalizedRole,
    entityType: optionalText(entityType, "entityType", 60),
    entityId: optionalText(entityId, "entityId", 100),
    requestId: optionalText(requestId, "requestId", 100),
    ipHash: requestMeta.ipHash,
    userAgentHash: requestMeta.userAgentHash,
    metadata: sanitizeHotelAuditMetadata(metadata),
  });
}

export async function safeRecordHotelAudit(connection, event = {}) {
  try {
    return await recordHotelAudit(connection, event);
  } catch (error) {
    const message = redactSensitiveText(error?.message || error?.name || "unknown");
    console.warn("[hotel/audit] write failed:", message);
    return null;
  }
}
