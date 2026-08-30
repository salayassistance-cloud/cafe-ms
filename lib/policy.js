// Canonical Authorization Policy — single source of truth for role permissions.
// All API routes and Server Actions MUST consult this module instead of scattering
// hard-coded role strings. Prevents duplicated `"MANAGER" === role` checks.
//
// Roles are the Staff enum (lib/models/Staff STAFF_ROLES). Session payload
// is the HttpOnly cookie decoded by lib/sessionCrypto verifySessionToken.
//
// Usage:
//   import { can, ROLES, requireRole } from "@/lib/policy";
//   const auth = await requireAuth(request, ROLES.MANAGER_ONLY);
//   if (!can(session.role, "menu:mutate")) return fail("Forbidden",403);

export const ROLES = {
  WAITER: "WAITER",
  KITCHEN: "KITCHEN",
  BARISTA: "BARISTA",
  MANAGER: "MANAGER",
};

export const ALL_ROLES = [ROLES.WAITER, ROLES.KITCHEN, ROLES.BARISTA, ROLES.MANAGER];

// Group helpers for requireAuth() callsites
export const GROUPS = {
  MANAGER_ONLY: [ROLES.MANAGER],
  STAFF_ANY: ALL_ROLES, // any authenticated staff
  WAITER_OR_MANAGER: [ROLES.WAITER, ROLES.MANAGER],
  KITCHEN_OR_BARISTA_OR_MANAGER: [ROLES.KITCHEN, ROLES.BARISTA, ROLES.MANAGER],
  KITCHEN_OR_MANAGER: [ROLES.KITCHEN, ROLES.MANAGER],
  BARISTA_OR_MANAGER: [ROLES.BARISTA, ROLES.MANAGER],
  WAITER_KITCHEN_BARISTA: [ROLES.WAITER, ROLES.KITCHEN, ROLES.BARISTA],
};

// Resource-scoped permission matrix — explicit, enumerable, testable.
// Keys are `resource:action`. Values are allowed roles.
// This is intentionally flat (no inheritance) so audits are trivial.
const MATRIX = {
  // Menu / Catalog (public read, manager mutate)
  "menu:read": null, // null = public / no auth required
  "menu:mutate": [ROLES.MANAGER],
  "category:mutate": [ROLES.MANAGER],
  "brand:read": null,
  "brand:mutate": [ROLES.MANAGER],
  "paymentInfo:read": null,
  "paymentInfo:mutate": [ROLES.MANAGER],

  // Orders — lifecycle is centralized in lib/orderService state machine
  "orders:create": [ROLES.WAITER, ROLES.MANAGER],
  "orders:read": ALL_ROLES, // active board is visible to all terminals; consider tightening later
  "orders:read:all": [ROLES.MANAGER], // full history / reports
  // Status transitions — maps to lib/orderService guards
  "orders:transition:PENDING": [ROLES.WAITER, ROLES.MANAGER], // implicit on create
  "orders:transition:PREPARING": [ROLES.KITCHEN, ROLES.BARISTA, ROLES.MANAGER],
  "orders:transition:READY": [ROLES.KITCHEN, ROLES.BARISTA, ROLES.MANAGER],
  "orders:transition:SERVED": [ROLES.WAITER, ROLES.MANAGER],
  "orders:transition:PAID": [ROLES.WAITER, ROLES.MANAGER],
  "orders:transition:ARCHIVED": [ROLES.KITCHEN, ROLES.BARISTA, ROLES.MANAGER],
  "orders:transition:CANCELLED": [ROLES.MANAGER],
  "orders:payment": [ROLES.WAITER, ROLES.MANAGER],
  "orders:external": [ROLES.WAITER, ROLES.MANAGER],

  // Reports / Analytics
  "reports:read": [ROLES.MANAGER],
  "analytics:read": [ROLES.MANAGER],

  // Staff / Auth
  "staff:read": ALL_ROLES,
  "staff:mutate": [ROLES.MANAGER],
  "staff:changePin": ALL_ROLES, // self or manager can change; enforced per handler
  "settings:pins": [ROLES.MANAGER],
  "settings:waiters": [ROLES.MANAGER],
  "settings:clearOrders": [ROLES.MANAGER],

  // Events (SSE is open by design — terminals need it pre-auth for waiter grid)
  "events:subscribe": null,
  "waiter:active": null,
};

export function normalizeRole(role) {
  if (!role) return null;
  const r = String(role).trim().toUpperCase();
  return ALL_ROLES.includes(r) ? r : null;
}

export function can(role, permission) {
  if (!(permission in MATRIX)) return false;
  const allowed = MATRIX[permission];
  if (allowed === null) return true; // public
  const r = normalizeRole(role);
  if (!r) return false;
  return allowed.includes(r);
}

export function canTransition(role, status) {
  const key = `orders:transition:${String(status).toUpperCase()}`;
  return can(role, key);
}

// Throws object { status, error } for fail() helpers, returns { ok, payload }
// Mirrors lib/security requireAuth shape for drop-in use.
export async function authorize(request, permission) {
  const { requireAuth } = await import("@/lib/security");
  const allowed = MATRIX[permission];
  if (allowed === null) return { ok: true, payload: null }; // public
  if (!allowed) return { ok: false, status: 403, error: `Unknown permission: ${permission}` };
  const auth = await requireAuth(request, allowed);
  return auth;
}

// Helper for Server Actions / Server Components where `cookies()` is available.
// Returns payload or null; caller must map null → error.
export async function getAuthorizedSession(requiredRoles) {
  try {
    const { cookies } = await import("next/headers");
    const { verifySessionToken, SESSION_COOKIE } = await import("@/lib/sessionCrypto");
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const payload = verifySessionToken(token);
    if (!payload || !payload.role) return null;
    const role = normalizeRole(payload.role);
    if (requiredRoles && !requiredRoles.includes(role)) return null;
    return payload;
  } catch {
    return null;
  }
}
