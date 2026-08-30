// Central security configuration — single source for default PINs.
// Do NOT expose raw PINs to client bundles; this module is server-only.
// DEFAULT_WAITER_PIN is the PIN assigned when Manager resets a waiter's PIN.
// It is stored only as hash (Staff.pinHash) via pinCrypto.hashPin.

export const DEFAULT_WAITER_PIN = process.env.DEFAULT_WAITER_PIN || "1111";
export const DEFAULT_KITCHEN_PIN = process.env.DEFAULT_KITCHEN_PIN || "2222";
export const DEFAULT_BARISTA_PIN = process.env.DEFAULT_BARISTA_PIN || "3333";
export const DEFAULT_MANAGER_PIN = process.env.DEFAULT_MANAGER_PIN || "4444";

// Validate defaults are 4 digits at import time (fail fast if misconfigured)
for (const [k, v] of Object.entries({ DEFAULT_WAITER_PIN, DEFAULT_KITCHEN_PIN, DEFAULT_BARISTA_PIN, DEFAULT_MANAGER_PIN })) {
  if (!/^\d{4}$/.test(v)) {
    throw new Error(`${k} must be exactly 4 digits — got "${v}"`);
  }
}
