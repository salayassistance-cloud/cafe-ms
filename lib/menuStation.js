// menuStation.js — pure station vocabulary and MenuItem station resolution.
//
// The same field priority is used by menu serialization (lib/menuService.js),
// recipe stock-area compatibility, and order snapshotting. It lives in a
// dependency-free module so DB-free tests can exercise it without the Next.js
// path-alias loader.

export const STATIONS = Object.freeze({
  KITCHEN: "KITCHEN",
  BARISTA: "BARISTA",
  HOT_DRINK: "HOT_DRINK",
});

// Authoritative station resolution for a MenuItem document:
// explicit targetStation > explicit station > categoryType fallback.
// Client-supplied station values are never an input to this function.
export function resolveMenuItemStation(item) {
  if (!item) return STATIONS.KITCHEN;
  return (
    item.targetStation ||
    item.station ||
    (item.categoryType === "HOT_DRINK"
      ? STATIONS.HOT_DRINK
      : item.categoryType === "DRINK"
        ? STATIONS.BARISTA
        : STATIONS.KITCHEN)
  );
}
