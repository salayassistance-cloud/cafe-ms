// Canonical inventory categories for the four physically separate stock areas.
//
// `InventoryItem.stockGroup` is the authoritative grouping. It is optional so
// legacy free-text items stay readable and are never guessed into a category
// (no automatic backfill). `category` remains the manager-visible label and is
// independent of the stock group.

export const STOCK_GROUP = Object.freeze({
  KITCHEN: "KITCHEN",
  BARISTA: "BARISTA",
  JEBENA: "JEBENA",
  EXTRA: "EXTRA",
});

export const STOCK_GROUP_VALUES = Object.freeze(Object.values(STOCK_GROUP));

export const STOCK_GROUP_LABELS = Object.freeze({
  KITCHEN: "Kitchen Stock",
  BARISTA: "Barista Stock",
  JEBENA: "Jebena Buna Stock",
  EXTRA: "Extra Items",
});

// Inventory stock that backs sellable Extra Items lives in the Extra Items
// group. It is still a normal InventoryItem with a canonical unit and stock.
export const EXTRA_ITEM_CATEGORY = STOCK_GROUP_LABELS.EXTRA;

export const EXTRA_ITEM_CATEGORIES = Object.freeze([
  STOCK_GROUP_LABELS.KITCHEN,
  STOCK_GROUP_LABELS.BARISTA,
  STOCK_GROUP_LABELS.JEBENA,
  STOCK_GROUP_LABELS.EXTRA,
]);

export function isStockGroup(value) {
  return typeof value === "string" && STOCK_GROUP_VALUES.includes(value);
}

// Returns a canonical stock group or null for an empty/absent value. Unknown
// values return null; callers that validate user input must reject null when a
// value was actually supplied.
export function normalizeStockGroup(value) {
  if (value == null) return null;
  const text = String(value).trim().toUpperCase();
  if (!text) return null;
  return isStockGroup(text) ? text : null;
}

export function stockGroupLabel(value) {
  const group = normalizeStockGroup(value);
  return group ? STOCK_GROUP_LABELS[group] : null;
}

// Recipe compatibility: a MenuItem's preparation station fixes the stock area
// its recipe may consume. HOT_DRINK is the Jebena Buna station and maps to the
// JEBENA stock area. This is intentionally a station → area mapping only; it is
// never used to guess a stockGroup for an existing inventory record.
export const STATION_STOCK_GROUP = Object.freeze({
  KITCHEN: STOCK_GROUP.KITCHEN,
  BARISTA: STOCK_GROUP.BARISTA,
  HOT_DRINK: STOCK_GROUP.JEBENA,
});

export function stockGroupForStation(station) {
  if (!station) return null;
  return STATION_STOCK_GROUP[String(station).trim().toUpperCase()] || null;
}
