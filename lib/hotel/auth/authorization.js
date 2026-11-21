// Hotel-only role/permission matrix.
//
// Authorization must be evaluated against the LIVE HotelUser.role loaded by
// the authentication service. A cookie, request body, JWT claim, or
// `roleSnapshot` from a session row must never be used as the authority.

import { HOTEL_ROLES } from "../constants.js";
import { HotelApiError, HOTEL_ERROR_CODES } from "../errors.js";

export const HOTEL_PERMISSIONS = Object.freeze({
  DASHBOARD_READ: "hotel.dashboard.read",
  ROOM_TYPES_READ: "hotel.roomTypes.read",
  ROOM_TYPES_MANAGE: "hotel.roomTypes.manage",
  ROOMS_READ: "hotel.rooms.read",
  ROOMS_MANAGE: "hotel.rooms.manage",
  RESERVATIONS_READ: "hotel.reservations.read",
  RESERVATIONS_MANAGE: "hotel.reservations.manage",
  GUESTS_READ: "hotel.guests.read",
  GUESTS_MANAGE: "hotel.guests.manage",
  BILLING_READ: "hotel.billing.read",
  BILLING_MANAGE: "hotel.billing.manage",
  REPORTS_READ: "hotel.reports.read",
  STAFF_MANAGE: "hotel.staff.manage",
  AUDIT_READ: "hotel.audit.read",
  SETTINGS_MANAGE: "hotel.settings.manage",
});

const ALL_PERMISSIONS = Object.freeze(Object.values(HOTEL_PERMISSIONS));

const ROLE_PERMISSIONS = Object.freeze({
  MANAGER: ALL_PERMISSIONS,
  RECEPTIONIST: Object.freeze([
    HOTEL_PERMISSIONS.DASHBOARD_READ,
    HOTEL_PERMISSIONS.ROOM_TYPES_READ,
    HOTEL_PERMISSIONS.ROOMS_READ,
    HOTEL_PERMISSIONS.RESERVATIONS_READ,
    HOTEL_PERMISSIONS.RESERVATIONS_MANAGE,
    HOTEL_PERMISSIONS.GUESTS_READ,
    HOTEL_PERMISSIONS.GUESTS_MANAGE,
    HOTEL_PERMISSIONS.BILLING_READ,
    HOTEL_PERMISSIONS.BILLING_MANAGE,
  ]),
});

export function normalizeHotelRole(role) {
  const normalized = String(role ?? "").trim().toUpperCase();
  return HOTEL_ROLES.includes(normalized) ? normalized : null;
}

export function permissionsForHotelRole(role) {
  const normalized = normalizeHotelRole(role);
  return normalized ? ROLE_PERMISSIONS[normalized] : [];
}

export function canHotel(role, permission) {
  if (typeof permission !== "string" || !ALL_PERMISSIONS.includes(permission)) {
    return false;
  }
  return permissionsForHotelRole(role).includes(permission);
}

export function assertHotelPermission(role, permission) {
  if (!canHotel(role, permission)) {
    throw new HotelApiError({
      code: HOTEL_ERROR_CODES.FORBIDDEN,
      message: "You do not have permission to perform this action",
      status: 403,
      expose: true,
    });
  }
  return true;
}

export function assertHotelRole(role, allowedRoles) {
  const normalized = normalizeHotelRole(role);
  if (!normalized) {
    throw new HotelApiError({
      code: HOTEL_ERROR_CODES.FORBIDDEN,
      message: "You do not have permission to perform this action",
      status: 403,
      expose: true,
    });
  }
  if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
    const allowed = allowedRoles
      .map(normalizeHotelRole)
      .filter(Boolean);
    if (!allowed.includes(normalized)) {
      throw new HotelApiError({
        code: HOTEL_ERROR_CODES.FORBIDDEN,
        message: "You do not have permission to perform this action",
        status: 403,
        expose: true,
      });
    }
  }
  return normalized;
}

export { ROLE_PERMISSIONS };
