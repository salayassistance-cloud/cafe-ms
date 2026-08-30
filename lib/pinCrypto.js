// PIN hashing helpers for the multi-portal POS. 4-digit terminal PINs are hashed
// with scrypt + a per-hash random salt so the stored value is never plaintext.
// Verification uses a constant-time comparison to avoid timing side-channels.

import crypto from "crypto";

export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return `${salt}:${derived}`;
}

// True when the stored value matches the `salt:derived` scrypt layout produced
// by hashPin (16-byte salt + 32-byte key, hex-encoded).
export function isHashedPin(stored) {
  return (
    typeof stored === "string" &&
    /^[0-9a-f]{32}:[0-9a-f]{64}$/.test(stored)
  );
}

export function verifyPin(pin, stored) {
  if (!stored || typeof stored !== "string" || !stored.includes(":")) {
    return false;
  }
  const [salt, key] = stored.split(":");
  const derived = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  const a = Buffer.from(derived, "hex");
  const b = Buffer.from(key || "", "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
