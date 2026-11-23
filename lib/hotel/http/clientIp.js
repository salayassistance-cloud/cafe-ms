// Hotel trusted client IP extraction.
//
// Supports Netlify (x-nf-client-connection-ip), Render (cf-connecting-ip /
// true-client-ip via Render's Cloudflare edge), and standard reverse proxies
// (x-real-ip, x-forwarded-for leftmost client hop).
//
// Security & Throttling:
//  - Priority 1: Edge-authenticated platform headers (Netlify's
//    `x-nf-client-connection-ip` and Render/Cloudflare's `cf-connecting-ip` /
//    `true-client-ip`). These are injected and overwritten at the platform edge
//    and CANNOT be spoofed by an end user sending custom request headers.
//  - Priority 2: Reverse-proxy direct headers (`x-real-ip`, `x-forwarded-for`).
//  - Validates and sanitizes IPv4 and IPv6 format (strips ports, bracketed forms).
//  - Fallback: If no valid proxy IP header is found, returns null so rate limiting
//    applies the bounded fail-closed HOTEL_UNTRUSTED_BUCKET ("untrusted").
//  - Account lockout (5 failed attempts -> 5 min lockout on HotelUser) operates
//    independently as the primary brute-force mitigation per identity.
//  - No raw IP is ever logged directly or returned to a client (hashes used in audit).

export const HOTEL_TRUSTED_IP_HEADER = "x-nf-client-connection-ip";
export const HOTEL_TRUSTED_IP_HEADERS = Object.freeze([
  "x-nf-client-connection-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-real-ip",
  "x-forwarded-for",
]);
export const HOTEL_UNTRUSTED_BUCKET = "untrusted";

const IP_V4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const IP_V6_RE = /^[0-9a-fA-F:]+$/;

export function sanitizeIpCandidate(raw) {
  if (!raw || typeof raw !== "string") return null;
  let val = raw.trim();
  if (val.startsWith("[")) {
    const end = val.indexOf("]");
    if (end > 0) val = val.slice(1, end);
  } else if (val.toLowerCase().startsWith("::ffff:")) {
    val = val.slice(7);
  } else if (val.includes(".") && val.includes(":")) {
    val = val.split(":")[0].trim();
  }
  if (IP_V4_RE.test(val)) return val;
  if (val.length >= 2 && IP_V6_RE.test(val) && val.includes(":")) return val.slice(0, 45);
  return null;
}

export function getTrustedHotelClientIp(request) {
  if (!request?.headers || typeof request.headers.get !== "function") {
    return null;
  }

  // 1. Netlify edge-set connection IP (single IP, overwritten at edge)
  try {
    const netlify = request.headers.get("x-nf-client-connection-ip");
    if (netlify) {
      const sanitized = sanitizeIpCandidate(netlify);
      if (sanitized) return sanitized;
    }
  } catch {}

  // 2. Render / Cloudflare edge-set connection IP (overwritten at edge, un-spoofable)
  try {
    const cf = request.headers.get("cf-connecting-ip");
    if (cf) {
      const sanitized = sanitizeIpCandidate(cf);
      if (sanitized) return sanitized;
    }
  } catch {}

  // 3. Cloudflare True-Client-IP header
  try {
    const trueClient = request.headers.get("true-client-ip");
    if (trueClient) {
      const sanitized = sanitizeIpCandidate(trueClient);
      if (sanitized) return sanitized;
    }
  } catch {}

  // 4. Reverse proxy X-Real-IP
  try {
    const real = request.headers.get("x-real-ip");
    if (real) {
      const sanitized = sanitizeIpCandidate(real);
      if (sanitized) return sanitized;
    }
  } catch {}

  // 5. Reverse proxy X-Forwarded-For fallback (take leftmost client hop)
  try {
    const fwd = request.headers.get("x-forwarded-for");
    if (fwd) {
      const firstHop = fwd.split(",")[0].trim();
      const sanitized = sanitizeIpCandidate(firstHop);
      if (sanitized) return sanitized;
    }
  } catch {}

  return null;
}
