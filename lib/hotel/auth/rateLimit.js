// Hotel-only login/credential rate limiting (Phase 3F / E-03, E-13, E-26).
//
// Independent of the POS `lib/rateLimit.js`. Fixed-window counters keyed by
// operation + TRUSTED client IP, stored in a process-global Map. The store is
// intentionally not shared between instances (see deployment note below).
//
// Trust policy: only a platform-set header is accepted as client identity.
// When no trusted IP is available, all such requests share one documented
// fail-closed bucket with a higher but still bounded limit, so throttling can
// never be silently bypassed by spoofing forwarding headers. Per-identity
// lockout remains the primary brute-force control.
//
// Deployment limitation (deferred E-04): this store is per-process and
// volatile. Multi-instance or serverless deployments need a shared store.

import {
  getTrustedHotelClientIp,
  HOTEL_UNTRUSTED_BUCKET,
} from "../http/clientIp.js";

const STORE_KEY = "__bonoHotelAuthRateLimitStore";
const MAX_KEYS = 500;

export const HOTEL_RATE_LIMITS = Object.freeze({
  LOGIN: Object.freeze({ limit: 5, untrustedLimit: 30, windowMs: 60_000 }),
  CHANGE_PIN: Object.freeze({ limit: 10, untrustedLimit: 60, windowMs: 60_000 }),
  LOGOUT: Object.freeze({ limit: 10, untrustedLimit: 60, windowMs: 60_000 }),
  DIRECTORY: Object.freeze({ limit: 30, untrustedLimit: 120, windowMs: 60_000 }),
  STAFF_MUTATION: Object.freeze({ limit: 20, untrustedLimit: 80, windowMs: 60_000 }),
});

function store() {
  if (!globalThis[STORE_KEY]) globalThis[STORE_KEY] = new Map();
  return globalThis[STORE_KEY];
}

// Kept as an exported, documented helper for callers and tests. Returns null
// when no trusted platform IP is present — never a client-supplied value.
export function hotelClientIp(request) {
  return getTrustedHotelClientIp(request);
}

export function hotelRetryAfterSeconds(retryAfterMs) {
  return Math.max(1, Math.ceil(Number(retryAfterMs || 0) / 1000));
}

export function checkHotelRateLimit(
  request,
  {
    key = "hotel_auth",
    limit = 5,
    untrustedLimit = limit,
    windowMs = 60_000,
    now = Date.now(),
  } = {}
) {
  const ip = hotelClientIp(request);
  const bucketKey = `${key}:${ip || HOTEL_UNTRUSTED_BUCKET}`;
  const effectiveLimit = ip ? limit : untrustedLimit;
  const buckets = store();
  const existing = buckets.get(bucketKey);
  const current = Number(now);

  if (!existing || current >= existing.resetAt) {
    const resetAt = current + windowMs;
    buckets.set(bucketKey, { count: 1, resetAt });
    if (buckets.size > MAX_KEYS) {
      // Map iterates in insertion order: evict oldest entries, live or not,
      // so an attacker rotating headers cannot grow the map without bound.
      const iterator = buckets.keys();
      while (buckets.size > MAX_KEYS) {
        const oldest = iterator.next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
    }
    return { ok: true, remaining: Math.max(0, effectiveLimit - 1), retryAfterMs: 0 };
  }

  if (existing.count >= effectiveLimit) {
    return { ok: false, remaining: 0, retryAfterMs: existing.resetAt - current };
  }

  existing.count += 1;
  buckets.set(bucketKey, existing);
  return {
    ok: true,
    remaining: Math.max(0, effectiveLimit - existing.count),
    retryAfterMs: 0,
  };
}

export function resetHotelRateLimitStore() {
  if (globalThis[STORE_KEY]) globalThis[STORE_KEY].clear();
}
