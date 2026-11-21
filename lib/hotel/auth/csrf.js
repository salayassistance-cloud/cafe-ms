import crypto from "crypto";

import { HOTEL_CSRF_TOKEN_BYTES } from "../constants.js";
import { requireHotelSessionSecret } from "../config.js";
import {
  HOTEL_ERROR_CODES,
  HotelApiError,
} from "../errors.js";

// Session-bound CSRF tokens.
//
// Login returns a random token once in the JSON body. Only an HMAC of that
// token is stored on the HotelSession row. State-changing authenticated
// requests must send the raw token in the X-Hotel-CSRF-Token header. This
// avoids a second long-lived credential cookie and binds the token to one
// session. SameSite=Strict and exact Origin validation remain in force.

const CSRF_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CSRF_HASH_RE = /^[0-9a-f]{64}$/;
const HMAC_DOMAIN = "bono-hotel-csrf-v1";
// The session-bound token is derived from the opaque session token with a
// separate HMAC domain. This makes issuance deterministic: every bootstrap for
// the same session returns the same token instead of overwriting the stored
// hash and invalidating other tabs/renders that still hold the previous token.
const DERIVE_DOMAIN = "bono-hotel-csrf-session-v1";

function assertServerOnly() {
  if (typeof window !== "undefined") {
    throw new Error("Hotel CSRF helpers are server-only");
  }
}

export function generateHotelCsrfToken() {
  assertServerOnly();
  return crypto.randomBytes(HOTEL_CSRF_TOKEN_BYTES).toString("base64url");
}

export function isHotelCsrfToken(value) {
  return typeof value === "string" && CSRF_TOKEN_RE.test(value);
}

// Deterministically derive the session-bound CSRF token from the opaque
// session token. Returns null for malformed input so callers can fail closed
// without throwing. The raw token and the result are never logged or stored in
// plaintext; only the HMAC of the result is persisted.
export function deriveHotelSessionCsrfToken(rawSessionToken) {
  assertServerOnly();
  // Session tokens are 32 random bytes in base64url, the same 43-character
  // alphabet as a CSRF token; no session-module import is needed (avoids a
  // circular dependency).
  if (
    typeof rawSessionToken !== "string" ||
    !CSRF_TOKEN_RE.test(rawSessionToken)
  ) {
    return null;
  }
  return crypto
    .createHmac("sha256", requireHotelSessionSecret())
    .update(`${DERIVE_DOMAIN}\u0000${rawSessionToken}`)
    .digest("base64url");
}

export function verifyDerivedHotelSessionCsrfToken(
  rawCsrfToken,
  rawSessionToken
) {
  if (!isHotelCsrfToken(rawCsrfToken)) return false;
  const expected = deriveHotelSessionCsrfToken(rawSessionToken);
  if (!expected) return false;
  return crypto.timingSafeEqual(
    Buffer.from(rawCsrfToken),
    Buffer.from(expected)
  );
}

export function hashHotelCsrfToken(rawToken) {
  assertServerOnly();
  if (!isHotelCsrfToken(rawToken)) {
    throw new HotelApiError({
      code: HOTEL_ERROR_CODES.CSRF_VALIDATION_FAILED,
      message: "Request verification failed",
      status: 403,
      expose: true,
    });
  }

  return crypto
    .createHmac("sha256", requireHotelSessionSecret())
    .update(`${HMAC_DOMAIN}\u0000${rawToken}`)
    .digest("hex");
}

export function verifyHotelCsrfToken(rawToken, expectedHash) {
  if (!isHotelCsrfToken(rawToken)) return false;
  if (typeof expectedHash !== "string" || !CSRF_HASH_RE.test(expectedHash)) {
    return false;
  }

  const actual = hashHotelCsrfToken(rawToken);
  return crypto.timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expectedHash, "hex")
  );
}
