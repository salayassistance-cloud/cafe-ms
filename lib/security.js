// Security hardening helpers: sanitization, CORS, CSP, auth guard.
// Used by middleware and API routes to enforce OWASP top-10 mitigations.

import { verifySessionToken, SESSION_COOKIE, SESSION_IDLE_TIMEOUT_MS, SESSION_IDLE_REFRESH_MS, createSessionToken, SESSION_COOKIE_OPTS } from "@/lib/sessionCrypto";

const ALLOWED_ORIGINS = [
  // Same-origin is always allowed (no Origin header)
  // Add explicit allowed origins via env ALLOWED_ORIGINS= https://example.com,https://admin.example.com
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean) : []),
];

// Check if origin is allowed (same-origin or allowlisted)
export function isOriginAllowed(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin / non-browser
  if (ALLOWED_ORIGINS.length === 0) {
    // In production with no allowlist, only allow same host as request
    const host = request.headers.get("host");
    if (!host) return false;
    try {
      const originUrl = new URL(origin);
      // Allow same host (with or without port)
      return originUrl.host === host;
    } catch {
      return false;
    }
  }
  return ALLOWED_ORIGINS.includes(origin);
}

export function corsHeaders(request) {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  if (!isOriginAllowed(request)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

export function handleCorsPreflight(request) {
  if (request.method === "OPTIONS") {
    if (!isOriginAllowed(request)) {
      return new Response(null, { status: 403, statusText: "Forbidden" });
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  return null;
}

// Prevent NoSQL injection: ensure query values are strings/numbers, not objects
// searchParams.get always returns string|null, but body JSON can contain objects
export function isNoSqlInjectionAttempt(value) {
  if (value == null) return false;
  if (typeof value === "object") {
    // Top-level operator injection: { "$gt": "" }, { "$ne": null }
    const keys = Object.keys(value);
    if (keys.some(k => k.startsWith("$"))) return true;
    // Nested check
    for (const v of Object.values(value)) {
      if (isNoSqlInjectionAttempt(v)) return true;
    }
  }
  return false;
}

export function stripOperators(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$") || k.startsWith("__")) continue;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      // Recursively strip
      out[k] = stripOperators(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Escape for safe embedding in HTML contexts (extra defense against stored XSS)
// React escapes by default, but this covers manually constructed strings
export function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Server-side auth guard for API routes - verifies HttpOnly session cookie
// Returns { ok: true, payload } or { ok: false, status, error }
export async function requireAuth(request, allowedRoles) {
  const cookieHeader = request.headers.get("cookie") || "";
  // Parse cookie manually (Next.js cookies() is not available in middleware/fetch context)
  // Look for bono_sess=<token>
  let token = null;
  const match = /(?:^|;\s*)bono_sess=([^;]+)/.exec(cookieHeader);
  if (match) token = decodeURIComponent(match[1]);

  // Also try Authorization: Bearer <token> fallback (for tests / API clients)
  if (!token) {
    const auth = request.headers.get("authorization");
    if (auth && auth.toLowerCase().startsWith("bearer ")) {
      token = auth.slice(7).trim();
    }
  }

  if (!token) {
    return { ok: false, status: 401, error: "Authentication required" };
  }

  const payload = verifySessionToken(token);
  if (!payload || !payload.role) {
    return { ok: false, status: 401, error: "Invalid or expired session" };
  }

  // Server-authoritative idle timeout (30 min). If the token's iat is older
  // than the idle window, the session is considered expired even though the
  // absolute exp (7 days) may still be valid. Active polling keeps refreshing.
  if (payload.iat && typeof payload.iat === "number") {
    const idleAge = Date.now() - Number(payload.iat);
    if (idleAge > SESSION_IDLE_TIMEOUT_MS) {
      return { ok: false, status: 401, error: "Your session has expired due to inactivity. Please sign in again." };
    }
  }

  // Sliding refresh: if the token is older than 5 min, re-issue a new token
  // with a fresh iat so active users never hit the idle timeout. Best-effort;
  // failures to set the cookie are non-fatal (next request will try again).
  if (payload.iat && Date.now() - Number(payload.iat) > SESSION_IDLE_REFRESH_MS) {
    try {
      const { iat: _iat, exp: _exp, ...rest } = payload;
      const newToken = createSessionToken(rest);
      // Set via next/headers cookies() if available (Route Handler context)
      const { cookies } = await import("next/headers");
      const store = await cookies();
      store.set(SESSION_COOKIE, newToken, SESSION_COOKIE_OPTS);
    } catch {
      // Not in a context where cookies() is available (e.g., middleware) — ignore
    }
  }

  // Waiter session validation — check Staff.isActive (soft-disable)
  if (payload.staffId) {
    try {
      const { connectToDatabase } = await import("@/lib/mongodb");
      const { getStaffModel } = await import("@/lib/models/Staff");
      const conn = await connectToDatabase();
      const Staff = getStaffModel(conn);
      const staff = await Staff.findById(payload.staffId).select("isActive role").lean();
      if (!staff || staff.isActive === false) {
        return { ok: false, status: 401, error: "Account disabled. Please contact manager.", code: "ACCOUNT_DISABLED" };
      }
      // Strict role check: session role must match Staff role
      if (staff.role !== String(payload.role).toUpperCase()) {
        return { ok: false, status: 403, error: "Role mismatch", code: "ROLE_MISMATCH" };
      }
    } catch {
      // If DB unavailable, don't block auth — allow token but will be re-checked on next request
    }
  }

  if (allowedRoles && allowedRoles.length > 0) {
    const role = String(payload.role).toUpperCase();
    const allowed = allowedRoles.map(r => String(r).toUpperCase());
    if (!allowed.includes(role)) {
      return { ok: false, status: 403, error: `Forbidden: requires ${allowed.join("/")} role` };
    }
  }

  return { ok: true, payload };
}

// Body size guard - reject overly large payloads to prevent DoS
export async function readJsonWithLimit(request, { maxBytes = 100 * 1024 } = {}) {
  const len = request.headers.get("content-length");
  if (len && Number(len) > maxBytes) {
    throw new Error(`Payload too large (max ${maxBytes} bytes)`);
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new Error(`Payload too large (max ${maxBytes} bytes)`);
  }
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (isNoSqlInjectionAttempt(parsed)) {
      throw new Error("Invalid payload: operator injection detected");
    }
    return parsed;
  } catch (e) {
    if (e.message.includes("operator injection") || e.message.includes("Payload too large")) throw e;
    throw new Error("Invalid JSON body");
  }
}
