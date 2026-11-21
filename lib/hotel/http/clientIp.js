// Hotel-only trusted client IP extraction.
//
// Security policy (Phase 3F / E-03):
//  - ONLY a platform/proxy-set header can identify a client. The current
//    source-recognized platform header is `x-nf-client-connection-ip`, which
//    is also used by the existing Hotel audit code.
//  - Raw client-supplied `x-forwarded-for` / `x-real-ip` are NEVER trusted:
//    any client can set them and mint an unlimited number of rate-limit keys.
//  - If no trusted header is present the result is null. Callers MUST apply a
//    documented fail-closed fallback bucket instead of silently skipping
//    throttling. No raw IP is ever logged or returned to a client.

export const HOTEL_TRUSTED_IP_HEADER = "x-nf-client-connection-ip";
export const HOTEL_UNTRUSTED_BUCKET = "untrusted";

const IP_SHAPE = /^[0-9a-fA-F:.]{3,64}$/;

export function getTrustedHotelClientIp(request) {
  let raw = "";
  try {
    raw = request?.headers?.get?.(HOTEL_TRUSTED_IP_HEADER) || "";
  } catch {
    return null;
  }
  const value = String(raw).trim();
  return IP_SHAPE.test(value) ? value : null;
}
