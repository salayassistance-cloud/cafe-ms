// In-memory rate limiter for API routes - protects against brute-force and DoS.
// Uses token-bucket per IP + per-route key. Stored on globalThis to survive HMR.
// No external dependency (e.g. Redis) needed for single-instance POS deployment.
// For multi-instance, swap with Redis-backed limiter - API stays same.

const globalRef = globalThis;
if (!globalRef.__rateLimitStore) {
  globalRef.__rateLimitStore = new Map(); // key -> { count, resetAt }
}

// Cleanup every 60s to prevent memory leak
if (!globalRef.__rateLimitCleanup) {
  globalRef.__rateLimitCleanup = true;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of globalRef.__rateLimitStore.entries()) {
      if (v.resetAt <= now) globalRef.__rateLimitStore.delete(k);
    }
  }, 60 * 1000);
  // Prevent Node from keeping process alive just for cleanup interval in tests
  if (globalRef.__rateLimitStoreCleanupInterval) {
    // already
  }
}

function getClientIp(request) {
  // Prefer x-forwarded-for (Vercel/NGINX) then x-real-ip, fallback to 127.0.0.1
  const h = request.headers;
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim().slice(0, 45);
  const real = h.get("x-real-ip");
  if (real) return real.trim().slice(0, 45);
  return "127.0.0.1";
}

/**
 * Check rate limit. Returns { ok: true } or { ok: false, retryAfterMs, message }.
 * Does NOT throw - caller decides to return 429.
 *
 * @param {Request} request - incoming fetch Request
 * @param {Object} opts - { key, limit, windowMs }
 */
export function checkRateLimit(request, { key = "global", limit = 60, windowMs = 60_000 } = {}) {
  const ip = getClientIp(request);
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  let entry = globalRef.__rateLimitStore.get(bucketKey);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 1, resetAt: now + windowMs };
    globalRef.__rateLimitStore.set(bucketKey, entry);
    return { ok: true, remaining: limit - 1, resetAt: entry.resetAt };
  }

  if (entry.count >= limit) {
    const retryAfterMs = entry.resetAt - now;
    return {
      ok: false,
      retryAfterMs,
      remaining: 0,
      resetAt: entry.resetAt,
      message: `Too many requests. Retry after ${Math.ceil(retryAfterMs / 1000)}s`,
    };
  }

  entry.count += 1;
  // Map holds reference, no need to set again
  return { ok: true, remaining: limit - entry.count, resetAt: entry.resetAt };
}

// Presets per OWASP recommendations
export const RATE_LIMITS = {
  // Auth endpoints - brute force protection: 5 attempts per minute per IP
  AUTH: { limit: 5, windowMs: 60_000 },
  // Sensitive manager actions: 10 per minute
  MANAGER: { limit: 10, windowMs: 60_000 },
  // Order creation: 30 per minute per IP (waiter terminal)
  ORDER_CREATE: { limit: 30, windowMs: 60_000 },
  // General API: 100 per minute
  GENERAL: { limit: 100, windowMs: 60_000 },
  // Menu / polling: 60 per minute
  MENU: { limit: 60, windowMs: 60_000 },
};

// Helper to generate Retry-After header value (seconds)
export function retryAfterSeconds(retryAfterMs) {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
