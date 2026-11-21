// Pure, framework-free portal resolution for the Hotel sign-in gate.
//
// The sign-in gate is shared by every protected Hotel destination, so the
// requested route — not a client-side role guess — decides which portal copy
// and which identity role are offered. Keeping this logic in a plain module
// makes it directly unit-testable and prevents a Manager-only route from ever
// silently becoming a Reception route (or the reverse).
//
// Authorization itself is NEVER decided here: server page guards and the
// Hotel API remain authoritative. This module only answers "which sign-in
// gate belongs on this URL" and "where may this authenticated role go".

export const HOTEL_PORTALS = Object.freeze({
  RECEPTION: Object.freeze({
    key: "RECEPTION",
    role: "RECEPTIONIST",
    destination: "/hotel/reception",
    titleKey: "login.receptionTitle",
    icon: "door",
  }),
  ROOMS: Object.freeze({
    key: "ROOMS",
    role: "MANAGER",
    destination: "/hotel/rooms",
    titleKey: "login.roomsTitle",
    icon: "dashboard",
  }),
  MANAGEMENT: Object.freeze({
    key: "MANAGEMENT",
    role: "MANAGER",
    destination: "/hotel/management",
    titleKey: "login.destinationManagement",
    icon: "users",
  }),
  REPORTS: Object.freeze({
    key: "REPORTS",
    role: "MANAGER",
    destination: "/hotel/reports",
    titleKey: "login.destinationReports",
    icon: "chart",
  }),
});

// Longest/most-specific prefixes first. Each protected Hotel route is mapped
// explicitly; anything else under /hotel falls back to the MANAGER-safe Rooms
// portal so an unknown Manager destination is never mislabelled as Reception.
const PORTAL_PREFIXES = Object.freeze([
  ["/hotel/reception", "RECEPTION"],
  ["/hotel/management", "MANAGEMENT"],
  ["/hotel/reports", "REPORTS"],
  ["/hotel/rooms", "ROOMS"],
]);

export function resolveHotelPortal(pathname) {
  const clean = String(pathname ?? "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/, "");
  for (const [prefix, key] of PORTAL_PREFIXES) {
    if (clean === prefix || clean.startsWith(`${prefix}/`)) {
      return HOTEL_PORTALS[key];
    }
  }
  return HOTEL_PORTALS.ROOMS;
}

// Canonical destination for a verified role. Used only as a safe fallback when
// the requested destination is not permitted for the authenticated role.
export function hotelHomeForRole(role) {
  return role === "RECEPTIONIST" ? "/hotel/reception" : "/hotel/rooms";
}

export function isAuthorizedDestinationForRole(role, destination) {
  const path = String(destination ?? "").replace(/\/+$/, "");
  if (role === "RECEPTIONIST") return path === "/hotel/reception";
  if (role === "MANAGER") {
    return ["/hotel/rooms", "/hotel/management", "/hotel/reports"].includes(path);
  }
  return false;
}
