// BONO server-side session cookies — AUTH-ARCH-3 wiring helpers.
//
// SERVER-ONLY. Never import from client components.
//
// Two cookies exist during the controlled rollout:
//
//   NEW (authoritative future):
//     __Host-bono_session -> opaque server-side Session.sessionId (no PII,
//     no role, no JSON/JWT/HMAC payload — meaningless by itself).
//
//   LEGACY (temporary compatibility, unchanged behavior):
//     bono_sess -> stateless HMAC payload verified by lib/sessionCrypto.
//     NEVER reinterpreted as a Session ID, NEVER stored in the Session
//     collection, NEVER converted into a Session.
//
// Precedence: when both are present the NEW server-side session wins; the
// legacy cookie can never override the new identity. requireAuth migration
// (AUTH-ARCH-4) will enforce this server-side; until then this module is the
// single definition of the rule.
//
// Cookie design:
//   HttpOnly, Secure always, SameSite=Strict, Path=/, no Domain.
//   `__Host-` prefix semantics require exactly that (Secure + Path=/ +
//   no Domain) — a `__Host-` Set-Cookie without Secure is ignored entirely
//   by the browser, which previously broke localhost development logins
//   (login 200, cookie never stored, portal layouts re-rendered PinGuard).
//   `Secure` is safe on http://localhost because localhost is a secure
//   context: Chromium/Firefox persist and send Secure cookies there.
//   Plain-http LAN/IP origins cannot use Secure cookies — serve those over
//   https or use localhost for local development.
//
// SECURITY: never log session IDs, cookies, PINs, or AUTH_SECRET. Use
// sessionFingerprint() from lib/sessionStore for diagnostics.

import { SESSION_ABSOLUTE_MS } from "./sessionStore.js";

export const NEW_SESSION_COOKIE = "__Host-bono_session";

export const NEW_SESSION_COOKIE_MAX_AGE_S = Math.floor(SESSION_ABSOLUTE_MS / 1000);

export const NEW_SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "strict",
  path: "/",
  // Always Secure: required by the `__Host-` prefix in every environment
  // (production behavior unchanged). localhost remains functional because it
  // is a secure context for cookie purposes.
  secure: true,
  maxAge: NEW_SESSION_COOKIE_MAX_AGE_S,
};

// Clear with identical scope so the browser reliably drops the cookie.
export const NEW_SESSION_COOKIE_DELETE_OPTS = {
  httpOnly: true,
  sameSite: "strict",
  path: "/",
  secure: true,
  maxAge: 0,
};

// Opaque session-ID shape: 32..128 base64url chars, no dots/braces/payload.
// Rejects HMAC tokens (`b64.sig`), JWTs (`a.b.c`), JSON, and empty values,
// so a legacy cookie value can never be mistaken for a Session ID.
const OPAQUE_RE = /^[A-Za-z0-9_-]{32,128}$/;

export function isOpaqueSessionValue(value) {
  return typeof value === "string" && OPAQUE_RE.test(value);
}

// Extract the NEW session ID from a raw Cookie header. Returns the opaque
// ID or null. Only reads `__Host-bono_session`; a `bono_sess` value is
// never returned here (different name AND non-opaque shape).
export function parseSessionIdFromCookieHeader(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  const match = /(?:^|;\s*)__Host-bono_session=([^;]+)/.exec(cookieHeader);
  if (!match) return null;
  let value = null;
  try {
    value = decodeURIComponent(match[1].trim());
  } catch {
    return null;
  }
  return isOpaqueSessionValue(value) ? value : null;
}

// Explicit, temporary compatibility rule (AUTH-ARCH-3 §G).
// Returns "server" | "legacy" | "none". The new session always wins.
export function resolveSessionPrecedence({ newSessionId, legacyToken } = {}) {
  if (isOpaqueSessionValue(newSessionId)) return "server";
  if (typeof legacyToken === "string" && legacyToken.length > 0) return "legacy";
  return "none";
}

// Extract request metadata for session rows. Raw values are returned for
// hashing by buildSessionDoc (hashRequestMeta) — callers must not log or
// persist them unhashed. IP is advisory only, never a session binding.
export function getRequestMeta(request) {
  try {
    const headers = request?.headers;
    const get = headers?.get?.bind(headers);
    if (typeof get !== "function") return { userAgent: null, ip: null };
    const userAgent = get("user-agent") || null;
    const forwarded = get("x-forwarded-for") || "";
    const ip = (forwarded.split(",")[0] || "").trim() || get("x-real-ip") || null;
    return {
      userAgent: typeof userAgent === "string" ? userAgent : null,
      ip: typeof ip === "string" ? ip : null,
    };
  } catch {
    return { userAgent: null, ip: null };
  }
}
