// Central security configuration — single source for default PINs.
// Do NOT expose raw PINs to client bundles; this module is server-only.
// DEFAULT_WAITER_PIN is the PIN assigned when Manager resets a waiter's PIN.
// It is stored only as hash (Staff.pinHash) via pinCrypto.hashPin.

export const DEFAULT_WAITER_PIN = process.env.DEFAULT_WAITER_PIN || "1111";
export const DEFAULT_KITCHEN_PIN = process.env.DEFAULT_KITCHEN_PIN || "2222";
export const DEFAULT_BARISTA_PIN = process.env.DEFAULT_BARISTA_PIN || "3333";
export const DEFAULT_HOT_DRINK_PIN = process.env.DEFAULT_HOT_DRINK_PIN || "5555";
export const DEFAULT_MANAGER_PIN = process.env.DEFAULT_MANAGER_PIN || "4444";

// Validate defaults are 4 digits at import time (fail fast if misconfigured)
for (const [k, v] of Object.entries({ DEFAULT_WAITER_PIN, DEFAULT_KITCHEN_PIN, DEFAULT_BARISTA_PIN, DEFAULT_HOT_DRINK_PIN, DEFAULT_MANAGER_PIN })) {
  if (!/^\d{4}$/.test(v)) {
    throw new Error(`${k} must be exactly 4 digits — got "${v}"`);
  }
}

// Phase 2.2 — production default-credential guard.
//
// The constants above remain the single comparison source for the Manager UI
// ("is this account still on its seeded PIN?") and for the idempotent seed
// scripts. They are NOT a credential authority: authentication always checks
// Staff.pinHash. A well-known default must nevertheless never work in
// production, so the auth paths reject these values when NODE_ENV=production.
//
// The literals are duplicated deliberately so this is an explicit, auditable
// allow-list of values that are banned in production — changing an env default
// does not silently widen the ban list.
export const KNOWN_DEFAULT_PINS = Object.freeze({
  WAITER: "1111",
  KITCHEN: "2222",
  BARISTA: "3333",
  HOT_DRINK: "5555",
  MANAGER: "4444",
});

export function isProductionRuntime(env = process.env) {
  return String(env?.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

export function isKnownDefaultPin(pin) {
  const value = String(pin ?? "");
  return Object.values(KNOWN_DEFAULT_PINS).includes(value);
}

/**
 * True when a PIN would be accepted only because it is a publicly known
 * default in a production runtime. Callers must fail closed without changing
 * their public error message (no account-enumeration signal).
 */
export function isRejectedDefaultCredential(pin, env = process.env) {
  return isProductionRuntime(env) && isKnownDefaultPin(pin);
}
