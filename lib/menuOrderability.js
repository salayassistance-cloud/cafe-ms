// D9/D10 — one DB-free orderability predicate for every menu consumer (Waiter
// and the public menu page).
//
// The catalog payload carries only a neutral boolean (`orderable`) and never the
// underlying inventory policy. Absence of the flag means "orderable", so a
// cached or older payload can never hide a valid menu item; the existing
// availability rules still apply.
//
// Presentation only: server-side order validation (orderService) remains the
// authoritative boundary. Filtering here never replaces that gate.

export function isMenuItemAvailable(item) {
  if (!item || typeof item !== "object") return false;
  return item.isAvailable !== false && item.inStock !== false;
}

export function isMenuItemOrderable(item) {
  return isMenuItemAvailable(item) && item?.orderable !== false;
}

// True only for an item that is otherwise in stock but blocked by a catalog /
// review decision. Those get a neutral "not available" label instead of the
// misleading "Out of Stock" one.
export function isMenuItemBlockedForReview(item) {
  return isMenuItemAvailable(item) && item?.orderable === false;
}
