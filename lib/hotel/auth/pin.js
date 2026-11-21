// Hotel-only PIN hashing and verification.
//
// This module is intentionally independent of the POS `lib/pinCrypto.js`.
// A 4-digit Hotel PIN is never persisted in plaintext: it is stored as
// `scrypt$N$r$p$<salt>$<derived>` with a fresh random salt. Verification uses
// a constant-time comparison so a wrong PIN cannot be distinguished by timing.
// No credential, hash, or PIN is ever logged here.

import crypto from "crypto";

export const HOTEL_PIN_RE = /^\d{4}$/;
export const HOTEL_PIN_SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1 });
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
// Node's default scrypt maxmem (32 MiB) is just below what N=32768,r=8 needs.
const SCRYPT_OPTIONS = Object.freeze({
  N: HOTEL_PIN_SCRYPT.N,
  r: HOTEL_PIN_SCRYPT.r,
  p: HOTEL_PIN_SCRYPT.p,
  maxmem: 64 * 1024 * 1024,
});

export function isValidHotelPin(pin) {
  return typeof pin === "string" && HOTEL_PIN_RE.test(pin);
}

export function hashHotelPin(pin) {
  if (!isValidHotelPin(pin)) {
    throw new Error("A Hotel PIN must be exactly four digits");
  }
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  const derived = crypto
    .scryptSync(String(pin), salt, KEY_LENGTH, SCRYPT_OPTIONS)
    .toString("hex");
  return `scrypt$${HOTEL_PIN_SCRYPT.N}$${HOTEL_PIN_SCRYPT.r}$${HOTEL_PIN_SCRYPT.p}$${salt}$${derived}`;
}

function parseHotelPinHash(stored) {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, n, r, p, salt, key] = parts;
  if (n !== String(HOTEL_PIN_SCRYPT.N) || r !== String(HOTEL_PIN_SCRYPT.r) || p !== String(HOTEL_PIN_SCRYPT.p)) {
    return null;
  }
  if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{64}$/.test(key)) return null;
  return { salt, key };
}

export function isHashedHotelPin(stored) {
  return parseHotelPinHash(stored) !== null;
}

export function verifyHotelPin(pin, stored) {
  const parsed = parseHotelPinHash(stored);
  if (!parsed || !isValidHotelPin(pin)) return false;
  const derived = crypto.scryptSync(
    String(pin),
    parsed.salt,
    KEY_LENGTH,
    SCRYPT_OPTIONS
  );
  const expected = Buffer.from(parsed.key, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// Asynchronous variant for request paths that verify many hashes (PIN
// collision scans). Same parameters, same constant-time comparison, but work
// runs on libuv's threadpool instead of blocking the Node event loop. Callers
// must await sequentially so concurrent KDF work stays bounded.
export async function verifyHotelPinAsync(pin, stored) {
  const parsed = parseHotelPinHash(stored);
  if (!parsed || !isValidHotelPin(pin)) return false;
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(
      String(pin),
      parsed.salt,
      KEY_LENGTH,
      SCRYPT_OPTIONS,
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });
  const expected = Buffer.from(parsed.key, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

let dummyHash = null;

// Used when an identity has no stored PIN or no user exists for the selected
// role, so an invalid identity still pays the same KDF cost as a wrong PIN.
export function dummyHotelPinHash() {
  if (!dummyHash) dummyHash = hashHotelPin("0000");
  return dummyHash;
}
