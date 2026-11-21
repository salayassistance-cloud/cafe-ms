// Phase 2.2 — PIN reset scope policy.
//
// Station roles (KITCHEN / BARISTA / HOT_DRINK) deliberately share one PIN per
// role: a single operator terminal signs in and the PIN is rotated for the
// whole station. WAITER and CASHIER are personal accounts.
//
// MANAGER is personal. A Manager reset must change only the addressed Manager
// account, never every Manager account. Before Phase 2.2 the Manager reset
// branch used a role-wide `Staff.updateMany({ role: "MANAGER" })`, which
// silently rotated the credential of every other Manager.
//
// This module is dependency-free so it can be unit-tested without a database.

export const ROLE_WIDE_PIN_ROLES = Object.freeze(["KITCHEN", "BARISTA", "HOT_DRINK"]);

export const PERSONAL_PIN_ROLES = Object.freeze(["WAITER", "CASHIER", "MANAGER"]);

export function pinResetScope(role) {
  const normalized = String(role ?? "").trim().toUpperCase();
  return ROLE_WIDE_PIN_ROLES.includes(normalized) ? "ROLE" : "PERSONAL";
}

export function isRoleWidePinRole(role) {
  return pinResetScope(role) === "ROLE";
}
