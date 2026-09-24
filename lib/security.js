// Security hardening helpers: sanitization, CORS, CSP, auth guard.
// Used by middleware and API routes to enforce OWASP top-10 mitigations.

// NOTE: requireAuth delegates to the canonical resolver in lib/serverAuth
// (AUTH-ARCH-4). Cookie parsing / HMAC details live there; this module keeps
// the public requireAuth(request, allowedRoles?) contract unchanged.

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

// Server-side auth guard for API routes — canonical resolver (ARCH-4/11,
// legacy-retired ARCH-8F). Precedence: X-Bono-Tab-Session (per-tab
// operational credential) first, then __Host-bono_session (Session -> live
// Staff). No legacy fallback: a request bearing only a legacy cookie (or
// nothing) receives 401. ARCH-6: Bearer is not accepted.
// Returns { ok: true, payload, authMethod } or { ok: false, status, error, code? }.
// The payload carries LIVE Staff identity (staffId/role/name/waiterNumber).
export async function requireAuth(request, allowedRoles) {
  const { parseAuthCookies, parseTabCredential, authenticateRequest } = await import("@/lib/serverAuth");
  const { connectToDatabase } = await import("@/lib/mongodb");
  const parsed = parseAuthCookies(request.headers.get("cookie") || "");
  const tabCredential = parseTabCredential(request.headers);
  return authenticateRequest({
    connectProvider: connectToDatabase,
    tabCredential,
    newSessionId: parsed.newSessionId,
    allowedRoles,
  });
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
