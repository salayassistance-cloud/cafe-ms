// Sellable inventory status — ONE pure implementation shared by the API
// serializers/services and the Manager UI.
//
// Sellability is `availableStock = currentStock - reservedStock`: stock held by
// live orders is not available to sell, so a low/out-of-stock decision must
// never be derived from physical `currentStock` alone. The persisted
// `InventoryItem.status` field is legacy/display-only and is NOT authoritative.
//
// This module has no imports and no side effects so it is safe to import from
// both server modules and client components.

export const INVENTORY_STATUS = Object.freeze({
  IN_STOCK: "In Stock",
  LOW_STOCK: "Low Stock",
  OUT_OF_STOCK: "Out Of Stock",
});

// Finite, deterministic available quantity. Missing/non-numeric values are
// treated as 0 rather than NaN so callers can never render "NaN".
export function availableStockOf(currentStock, reservedStock = 0) {
  const cur = Number(currentStock);
  const held = Number(reservedStock);
  const available =
    (Number.isFinite(cur) ? cur : 0) - (Number.isFinite(held) ? held : 0);
  return Number.isFinite(available) ? available : 0;
}

// Mirrors the DB-side aggregation used by inventoryAlertService /
// inventoryDashboardService:
//   out  : availableStock <= 0
//   low  : 0 < availableStock <= minimumStock
//   in   : availableStock > minimumStock
export function deriveInventoryStatus(
  currentStock,
  minimumStock,
  reservedStock = 0
) {
  const available = availableStockOf(currentStock, reservedStock);
  const min = Number(minimumStock);
  if (available <= 0) return INVENTORY_STATUS.OUT_OF_STOCK;
  if (Number.isFinite(min) && available <= min) return INVENTORY_STATUS.LOW_STOCK;
  return INVENTORY_STATUS.IN_STOCK;
}
