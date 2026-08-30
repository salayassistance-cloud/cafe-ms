// Signed session tokens. A session is a JSON payload (role + optional
// waiterNumber) HMAC-SHA256 signed with AUTH_SECRET. The token is stored in an
// HttpOnly cookie so it cannot be forged client-side, and the signature is
// verified on every guarded request. Works in both Route Handlers (Node) and
// Server Components.

import crypto from "crypto";

const RAW_SECRET = process.env.AUTH_SECRET;
if (process.env.NODE_ENV === "production" && !RAW_SECRET) {
  // Fail fast in production — dev fallback would allow session forgery.
  throw new Error("AUTH_SECRET must be set in production — refusing to use dev fallback");
}
const SECRET = RAW_SECRET || "bono-pos-dev-secret-change-me-in-production";

export const SESSION_COOKIE = "bono_sess";

export const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 7,
};

// Server-authoritative idle timeout — POS-appropriate 30 minutes.
// If no authenticated request is seen for this long, the next
// requireAuth will return 401 "Session expired due to inactivity".
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
// How often to refresh the rolling idle window on active use (5 min).
export const SESSION_IDLE_REFRESH_MS = 5 * 60 * 1000;

// For logout we need to delete with same path/sameSite/secure to ensure browser clears correctly
export const SESSION_COOKIE_DELETE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 0,
};

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function createSessionToken(payload) {
  const now = Date.now();
  const withMeta = {
    ...payload,
    iat: now,
    exp: now + SESSION_COOKIE_OPTS.maxAge * 1000,
  };
  const b64 = b64url(Buffer.from(JSON.stringify(withMeta)));
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(b64)
    .digest("hex");
  return `${b64}.${sig}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(b64)
    .digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    // Expiration check — prevents forever-valid stolen tokens (session fixation tampering)
    if (payload.exp && Date.now() > Number(payload.exp)) return null;
    // Also reject tokens issued in the future (clock skew tolerance 5s)
    if (payload.iat && Number(payload.iat) > Date.now() + 5000) return null;
    return payload;
  } catch {
    return null;
  }
}
