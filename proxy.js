import { NextResponse } from "next/server";

// Global middleware: CORS, rate-limit hints, security headers, and optional auth gating.
// Runs on every request but only enforces logic for /api routes; pages are left to their layout guards.

const RATE_LIMIT_ROUTES = [
  { pattern: /^\/api\/auth\//, key: "auth", limit: 10, windowMs: 60_000 },
  { pattern: /^\/api\/manager\//, key: "manager", limit: 20, windowMs: 60_000 },
  { pattern: /^\/api\/orders/, key: "orders", limit: 60, windowMs: 60_000 },
];

// Simple in-memory rate store for middleware (Edge-compatible - uses in-process Map)
// Note: Edge runtime is single-process; for multi-instance use Redis.
const g = globalThis;
if (!g.__mwRateStore) g.__mwRateStore = new Map();

function getIp(request) {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "127.0.0.1";
}

function checkMwRate(request, { key, limit, windowMs }) {
  const ip = getIp(request);
  const bucket = `${key}:${ip}`;
  const now = Date.now();
  let entry = g.__mwRateStore.get(bucket);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 1, resetAt: now + windowMs };
    g.__mwRateStore.set(bucket, entry);
    return { ok: true };
  }
  if (entry.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { ok: true };
}

export function proxy(request) {
  const { pathname } = request.nextUrl;

  // --- CORS preflight for API ---
  if (pathname.startsWith("/api/") && request.method === "OPTIONS") {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");
    let allowedOrigin = null;
    if (origin) {
      try {
        const o = new URL(origin);
        if (o.host === host) allowedOrigin = origin;
      } catch {}
    }
    if (allowedOrigin) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      });
    }
    // same-origin preflight without Origin header -> allow
    if (!origin) {
      return new NextResponse(null, { status: 204 });
    }
    return new NextResponse(JSON.stringify({ success: false, error: "CORS forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- Light rate limiting at edge for abusive clients ---
  if (pathname.startsWith("/api/")) {
    for (const rule of RATE_LIMIT_ROUTES) {
      if (rule.pattern.test(pathname)) {
        const res = checkMwRate(request, rule);
        if (!res.ok) {
          return NextResponse.json(
            { success: false, data: null, error: "Too many requests. Please slow down." },
            { status: 429, headers: { "Retry-After": String(res.retryAfter) } }
          );
        }
        break;
      }
    }
  }

  // --- Security headers already in next.config.mjs, but ensure no-store for operational APIs ---
  // Phase 5: menu/brand/payment-info are cacheable (60s s-maxage) — let their route handlers set Cache-Control.
  // Only force no-store for dynamic operational data (orders, manager, events, etc.).
  const CACHEABLE_API = /^\/(api\/menu|api\/brand|api\/payment-info)/;
  const response = NextResponse.next();
  if (pathname.startsWith("/api/") && !CACHEABLE_API.test(pathname)) {
    // Only set no-store if handler hasn't already set a Cache-Control (e.g., menu's public s-maxage)
    const existingCC = response.headers.get("Cache-Control");
    if (!existingCC || existingCC.includes("no-store")) {
      response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    }
    response.headers.set("X-Content-Type-Options", "nosniff");
  } else if (pathname.startsWith("/api/")) {
    // For cacheable APIs, ensure nosniff but don't overwrite their Cache-Control
    response.headers.set("X-Content-Type-Options", "nosniff");
  }
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};

// Back-compat alias — Next.js 16 renames middleware → proxy. Some tooling still
// resolves `middleware` export; keeping alias prevents double-proxy drift.
export { proxy as middleware };
