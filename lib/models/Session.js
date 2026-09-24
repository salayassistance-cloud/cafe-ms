// BONO server-side session record — canonical authentication authority.
// Identity resolves Session -> live Staff (isActive + role); see
// lib/serverAuth.js. AUTH-ARCH-8F retired the legacy HMAC path: no
// production code authenticates from bono_sess anymore.
//
// LIVE-ROLE PRINCIPLE (authoritative for all future phases):
//   session.sessionId -> session.staffId -> Staff.findById()
//     -> Staff.isActive -> Staff.role (LIVE) -> policy.can(...) -> allow/deny
// `roleSnapshot` below is audit/metadata ONLY and MUST NEVER grant permission.
// Cookie role / session roleSnapshot / client role / localStorage role are
// never final authorization authority.
//
// DEPLOYMENT NOTE (AUTH-ARCH-2 safety rule):
// Indexes are DEFINED here only. Do NOT run syncIndexes/createIndexes
// against production in this phase. lib/mongodb.js background sync is
// intentionally NOT extended here; a controlled deployment phase will
// enable it (see AUTH-ARCH-3). The `expiresAt` TTL index lets MongoDB
// garbage-collect expired rows without application deletes.
//
// CASHIER: first-class enum member. No CASHIER->MANAGER mapping exists
// anywhere in this layer (see PinLoginModal legacy bug — fixed in ARCH-3/6,
// not here).

import mongoose from "mongoose";

export const SESSION_ROLES = ["WAITER", "KITCHEN", "BARISTA", "CASHIER", "MANAGER"];

export const SESSION_REVOKE_REASONS = [
  "LOGOUT",
  "ROTATED",
  "DISABLED",
  "DELETED",
  "PIN_CHANGED",
  "PIN_RESET",
  "EXPIRED",
  "MANAGER_REVOKED",
  "SECURITY",
];

// Centralized lifetimes (mirrored in lib/sessionStore.js; model holds no
// durations itself — durations live in one place only).
//   Absolute: ~8h POS shift. Idle: ~30min. See sessionStore constants.

const SessionSchema = new mongoose.Schema(
  {
    // Opaque random pointer. 256-bit crypto.randomBytes -> base64url (43 chars).
    // NEVER derived from staffId/role/username, NEVER JWT, NEVER sequential.
    // Contains no PII by construction (validated by tests).
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      minlength: 32,
      maxlength: 128,
    },
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
      index: true,
    },
    // Audit/metadata snapshot at creation. NOT authority (see header).
    roleSnapshot: {
      type: String,
      enum: SESSION_ROLES,
      required: true,
      index: true,
    },
    lastSeenAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    expiresAt: {
      type: Date,
      required: true,
      // NOTE: no field-level `index: true` here on purpose. The TTL index is
      // defined once at schema level below ({ expiresAt: 1 },
      // { expireAfterSeconds: 0 }). A second field-level definition would
      // create the same index name with different options (IndexOptionsConflict
      // on deploy). See docs/auth-session-index-deployment.md (ARCH-7).
    },
    idleExpiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
    // Hashes only — never raw User-Agent / IP.
    userAgentHash: {
      type: String,
      default: null,
      maxlength: 128,
    },
    // Advisory anomaly signal ONLY. MUST NOT hard-bind sessions to an IP
    // (mobile/DHCP POS networks roam); never invalidate on IP change.
    ipHash: {
      type: String,
      default: null,
      maxlength: 128,
    },
    revokedAt: {
      type: Date,
      default: null,
      index: true,
    },
    revokeReason: {
      type: String,
      enum: [...SESSION_REVOKE_REASONS, "NONE"],
      default: null,
    },
    // AUTH-ARCH-11: tab access credential lookup. Stores ONLY the SHA-256 hex
    // of the raw per-tab credential (never the credential itself). A tab that
    // completed Staff login holds the raw value in JS memory only and sends
    // it via the X-Bono-Tab-Session header; the server hashes and looks the
    // session up by this field. Null for sessions never bound to a tab.
    // Same Session row serves the browser cookie (sessionId) and its tab(s).
    tabTokenHash: {
      type: String,
      default: null,
      maxlength: 128,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "sessions" }
);

// Lookup: sessionId unique (primary hot path).
SessionSchema.index({ sessionId: 1 }, { unique: true });
// Per-staff revocation/listing: staff sessions + active filter.
SessionSchema.index({ staffId: 1, revokedAt: 1 });
// TTL: MongoDB auto-deletes once expiresAt passes (no app deletes needed).
// Defined only — NOT applied to production in AUTH-ARCH-2.
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// AUTH-ARCH-11: tab-credential lookup (sparse: only tab-bound rows indexed).
// Defined only — same deployment procedure as the other Session indexes
// (see docs/auth-session-index-deployment.md addendum). Never blocks login:
// issuance writes the field; absence of the index only costs a scan.
SessionSchema.index({ tabTokenHash: 1 }, { unique: true, sparse: true });

export function getSessionModel(connection) {
  return (
    connection.models.Session ||
    connection.model("Session", SessionSchema, "sessions")
  );
}

// Default model for scripts/tests (single-connection mode).
const Session =
  mongoose.models.Session || mongoose.model("Session", SessionSchema, "sessions");

export default Session;
export { SessionSchema };
