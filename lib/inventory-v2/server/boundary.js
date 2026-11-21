// BONO Inventory V2 — server-only boundary guard.
//
// The `server-only` package is not installed in this repository. The existing
// repository convention is a plain runtime guard that fails closed when a module
// is evaluated in a browser bundle. This module is the single V2 implementation
// of that convention:
//
//   import { assertServerOnly } from "./boundary.js";
//   assertServerOnly("Inventory V2 transaction helper");
//
// Static ESLint enforcement lives in eslint.config.mjs and is the primary
// defence; this runtime guard is defence in depth. Bundler-level enforcement
// (`server-only`) remains a recommended future hardening step and is NOT
// claimed to exist in Phase 2.0.
//
// This module has no database, Mongoose, framework, or environment access.

export const INVENTORY_V2_SERVER_MODULE_PREFIX = "lib/inventory-v2/server/";

export function isServerRuntime() {
  return typeof window === "undefined";
}

/**
 * Fail closed when called from a browser/client bundle.
 *
 * @param {string} [scope] human-readable module or operation name
 */
export function assertServerOnly(scope = "Inventory V2 server module") {
  if (!isServerRuntime()) {
    throw new Error(
      `${scope} is server-only and must never be imported into a client bundle`
    );
  }
}

/**
 * Pure predicate used by tests and static checks. It intentionally does not
 * throw so callers can report every violation instead of only the first.
 */
export function isServerOnlyViolation(scope = "Inventory V2 server module") {
  try {
    assertServerOnly(scope);
    return false;
  } catch {
    return true;
  }
}

export default assertServerOnly;
