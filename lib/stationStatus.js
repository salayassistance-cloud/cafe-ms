// Canonical station model — single interpretation of station semantics.
//
// Data flow (no hardcoded per-page conditions):
//   Staff.role (LIVE, server) -> station -> station-scoped lines ->
//   station-scoped status field -> UI button.
// Overall order.status is DERIVED on the server (mixed orders: READY only
// when every required active station is READY) and must NEVER drive a
// station button — it can reflect the OTHER station's progress.
//
// Item-type routing (order routing only, never authorization):
//   FOOD <-> KITCHEN, DRINK <-> BARISTA.
// Authorization stays server-side: requireAuth + policy + role-derived
// station scoping in lib/orderService. This module is pure (DB-free,
// no imports) so tests and UI share exactly one interpretation.
//
// Station keyspace is 'KITCHEN' | 'BARISTA'; the KDS board `view` prop uses
// item types ('FOOD' | 'DRINK') — see stationForView.

export const STATIONS = ["KITCHEN", "BARISTA"];

export const STATION_ITEM_TYPE = {
  KITCHEN: "FOOD",
  BARISTA: "DRINK",
};

export const STATION_STATUS_FIELD = {
  KITCHEN: "kitchenStatus",
  BARISTA: "baristaStatus",
};

const TERMINAL_STATION = new Set(["PENDING", "PREPARING", "READY"]);

// Board view ('FOOD' | 'DRINK') -> canonical station. Null when unknown.
export function stationForView(view) {
  const v = String(view || "").toUpperCase();
  if (v === "FOOD") return "KITCHEN";
  if (v === "DRINK") return "BARISTA";
  return null;
}

// Authenticated Staff role -> operable station. Null for non-station roles
// (WAITER/CASHIER/MANAGER operate no KDS station).
export function stationForRole(role) {
  const r = String(role || "").toUpperCase();
  if (r === "KITCHEN") return "KITCHEN";
  if (r === "BARISTA") return "BARISTA";
  return null;
}

// This station's own status. Missing/invalid values mean PENDING — identical
// to the server, which treats null station state as not-started. The overall
// order.status is deliberately NOT consulted here.
export function stationStatusOf(order, station) {
  const field = STATION_STATUS_FIELD[station];
  if (!field || !order || typeof order !== "object") return "PENDING";
  const value = String(order[field] || "PENDING").toUpperCase();
  return TERMINAL_STATION.has(value) ? value : "PENDING";
}

// Active (non-cancelled) lines belonging to this station.
export function hasActiveStationLines(order, station) {
  const type = STATION_ITEM_TYPE[station];
  if (!type || !order || !Array.isArray(order.items)) return false;
  return order.items.some((it) => it && it.type === type && !it.cancelled);
}

// Button model for a station ticket: 'START_PREP' | 'MARK_READY' | null
// (null = no action: finished, unknown state, or no active station lines).
export function stationActionOf(order, station) {
  if (!hasActiveStationLines(order, station)) return null;
  const status = stationStatusOf(order, station);
  if (status === "PENDING") return "START_PREP";
  if (status === "PREPARING") return "MARK_READY";
  return null;
}

// Optimistic station update: changes ONLY this station's status field.
// Overall order.status is left untouched — the server response carries the
// canonical derived overall on success, and failure reverts. Never derive,
// guess, or copy the other station's state here.
export function applyStationUpdate(order, station, status) {
  if (!order || typeof order !== "object") return order;
  const field = STATION_STATUS_FIELD[station];
  if (!field) return order;
  const value = String(status || "").toUpperCase();
  if (!TERMINAL_STATION.has(value)) return order;
  return { ...order, [field]: value };
}
