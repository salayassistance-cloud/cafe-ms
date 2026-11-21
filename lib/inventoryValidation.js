// Inventory validation — follows lib/validate.js style (Zod-like, sanitize + strict).
import { sanitizeString, OBJECTID_RE } from "@/lib/validate";
import { normalizeStockGroup, STOCK_GROUP_VALUES } from "@/lib/inventoryCategories";
import { validateInventoryUnit, INVALID_UNIT_CODE } from "@/lib/inventoryUnitGuard";

const INVENTORY_STATUSES = ["In Stock", "Low Stock", "Out Of Stock"];
const SUPPLIER_STATUSES = ["Active", "Inactive"];
const MOVEMENT_TYPES = ["IN", "OUT", "ADJUSTMENT"];
const MOVEMENT_REASONS = ["Purchase", "SaleDeduction", "Waste", "Correction", "Initial"];

// D2 — inventory stock-unit change guard.
//
// An Extra Item stores no unit of its own: it deducts in the linked
// InventoryItem's live stock unit, and an order reservation freezes the unit it
// held. Changing the unit afterwards would make that hold deduct a different
// quantity in a different unit. This helper never converts, aliases or guesses
// a unit — it only decides whether the write must be blocked.
export const UNIT_IN_USE_CODE = "UNIT_IN_USE";

export function unitTextChanged(currentUnit, nextUnit) {
  if (nextUnit == null) return false;
  return String(nextUnit).trim() !== String(currentUnit ?? "").trim();
}

export function evaluateInventoryUnitChange({
  currentUnit,
  nextUnit,
  reservedStock = 0,
  extraItemLinked = false,
  recipeLinked = false,
}) {
  if (!unitTextChanged(currentUnit, nextUnit)) {
    return { changed: false, blocked: false, code: null, reason: null };
  }
  const reserved = Number(reservedStock);
  if (Number.isFinite(reserved) && reserved > 0) {
    return { changed: true, blocked: true, code: UNIT_IN_USE_CODE, reason: "RESERVED_STOCK" };
  }
  if (extraItemLinked === true) {
    return { changed: true, blocked: true, code: UNIT_IN_USE_CODE, reason: "EXTRA_ITEM_LINKED" };
  }
  if (recipeLinked === true) {
    return { changed: true, blocked: true, code: UNIT_IN_USE_CODE, reason: "RECIPE_LINKED" };
  }
  return { changed: true, blocked: false, code: null, reason: null };
}


function sanitizeRequiredString(val, maxLen, field) {
  const s = sanitizeString(val, { maxLen, allowEmpty: false });
  if (!s) return { error: `${field} is required` };
  return { value: s };
}

export function validateInventoryItemCreate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body: expected JSON object" };
  }
  const nameRes = sanitizeRequiredString(body.name, 100, "name");
  if (nameRes.error) return { error: nameRes.error };
  if (/<script/i.test(nameRes.value) || /javascript:/i.test(nameRes.value)) {
    return { error: "name contains invalid characters" };
  }
  const catRes = sanitizeRequiredString(body.category, 100, "category");
  if (catRes.error) return { error: catRes.error };
  const unitRes = sanitizeRequiredString(body.unit, 50, "unit");
  if (unitRes.error) return { error: unitRes.error, code: INVALID_UNIT_CODE };
  const unitCheck = validateInventoryUnit(unitRes.value, "unit");
  if (!unitCheck.ok) return { error: unitCheck.error, code: unitCheck.code };

  const data = {
    name: nameRes.value,
    category: catRes.value,
    unit: unitRes.value,
  };

  if (body.stockGroup != null && String(body.stockGroup).trim() !== "") {
    const group = normalizeStockGroup(body.stockGroup);
    if (!group) {
      return { error: `stockGroup must be one of ${STOCK_GROUP_VALUES.join(", ")}` };
    }
    data.stockGroup = group;
  }

  if (body.currentStock != null && String(body.currentStock).trim() !== "") {
    const n = Number(body.currentStock);
    if (!Number.isFinite(n) || n < 0) return { error: "currentStock must be number >= 0" };
    data.currentStock = n;
  }
  if (body.minimumStock != null && String(body.minimumStock).trim() !== "") {
    const n = Number(body.minimumStock);
    if (!Number.isFinite(n) || n < 0) return { error: "minimumStock must be number >= 0" };
    data.minimumStock = n;
  }
  if (body.cost != null && String(body.cost).trim() !== "") {
    const n = Number(body.cost);
    if (!Number.isFinite(n) || n < 0) return { error: "cost must be number >= 0" };
    data.cost = Math.round(n * 100) / 100;
  }
  if (body.supplier != null && String(body.supplier).trim() !== "") {
    const sid = String(body.supplier).trim();
    if (!OBJECTID_RE.test(sid)) return { error: "supplier must be valid ObjectId if provided" };
    data.supplier = sid;
  }
  if (body.status != null && String(body.status).trim() !== "") {
    const st = String(body.status).trim();
    if (!INVENTORY_STATUSES.includes(st)) return { error: `status must be one of ${INVENTORY_STATUSES.join(", ")}` };
    data.status = st;
  }
  return { ok: true, data };
}

export function validateInventoryItemUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body" };
  }
  const data = {};
  let hasField = false;

  if (body.name != null) {
    const s = String(body.name).trim();
    if (s !== "") {
      const sanitized = sanitizeString(s, { maxLen: 100 });
      if (!sanitized) return { error: "name must be 1-100 chars" };
      if (/<script/i.test(sanitized)) return { error: "name contains invalid characters" };
      data.name = sanitized;
      hasField = true;
    } else {
      return { error: "name cannot be empty" };
    }
  }
  if (body.category != null) {
    const s = String(body.category).trim();
    if (s !== "") {
      const sanitized = sanitizeString(s, { maxLen: 100 });
      if (!sanitized) return { error: "category must be 1-100 chars" };
      data.category = sanitized;
      hasField = true;
    } else {
      return { error: "category cannot be empty" };
    }
  }
  if (body.unit != null) {
    const s = String(body.unit).trim();
    if (s !== "") {
      const sanitized = sanitizeString(s, { maxLen: 50 });
      if (!sanitized) return { error: "unit must be 1-50 chars", code: INVALID_UNIT_CODE };
      const unitCheck = validateInventoryUnit(sanitized, "unit");
      if (!unitCheck.ok) return { error: unitCheck.error, code: unitCheck.code };
      data.unit = sanitized;
      hasField = true;
    } else {
      return { error: "unit cannot be empty", code: INVALID_UNIT_CODE };
    }
  }
  if (body.stockGroup !== undefined) {
    if (body.stockGroup == null || String(body.stockGroup).trim() === "") {
      data.stockGroup = null;
      hasField = true;
    } else {
      const group = normalizeStockGroup(body.stockGroup);
      if (!group) {
        return { error: `stockGroup must be one of ${STOCK_GROUP_VALUES.join(", ")}` };
      }
      data.stockGroup = group;
      hasField = true;
    }
  }
  if (body.minimumStock != null) {
    const n = Number(body.minimumStock);
    if (!Number.isFinite(n) || n < 0) return { error: "minimumStock must be number >= 0" };
    data.minimumStock = n;
    hasField = true;
  }
  if (body.cost != null) {
    const n = Number(body.cost);
    if (!Number.isFinite(n) || n < 0) return { error: "cost must be number >= 0" };
    data.cost = Math.round(n * 100) / 100;
    hasField = true;
  }
  if (body.status != null) {
    const st = String(body.status).trim();
    if (!INVENTORY_STATUSES.includes(st)) return { error: `status must be one of ${INVENTORY_STATUSES.join(", ")}` };
    data.status = st;
    hasField = true;
  }
  // currentStock is NOT allowed to be updated directly via PATCH (use StockMovement)
  // but spec lists updatable: name, category, unit, minimumStock, cost, status — so we exclude currentStock
  if (body.currentStock != null) {
    return { error: "currentStock cannot be updated directly" };
  }
  if (body.supplier != null) {
    const sid = String(body.supplier).trim();
    if (sid === "") {
      data.supplier = null;
      hasField = true;
    } else {
      if (!OBJECTID_RE.test(sid)) return { error: "supplier must be valid ObjectId" };
      data.supplier = sid;
      hasField = true;
    }
  }

  if (!hasField) return { error: "No update fields provided (need name, category, stockGroup, unit, minimumStock, cost, status, supplier)" };
  return { ok: true, data };
}

export function validateSupplierCreate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body: expected JSON object" };
  }
  const nameRes = sanitizeRequiredString(body.name, 100, "name");
  if (nameRes.error) return { error: nameRes.error };
  if (/<script/i.test(nameRes.value)) return { error: "name contains invalid characters" };
  const data = { name: nameRes.value };
  if (body.contact != null) {
    const s = sanitizeString(body.contact, { maxLen: 200, allowEmpty: true });
    if (s != null) data.contact = s;
  }
  if (body.address != null) {
    const s = sanitizeString(body.address, { maxLen: 500, allowEmpty: true });
    if (s != null) data.address = s;
  }
  if (body.status != null && String(body.status).trim() !== "") {
    const st = String(body.status).trim();
    if (!SUPPLIER_STATUSES.includes(st)) return { error: `status must be one of ${SUPPLIER_STATUSES.join(", ")}` };
    data.status = st;
  }
  return { ok: true, data };
}

export function validateSupplierUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body" };
  }
  const data = {};
  let hasField = false;
  if (body.name != null) {
    const s = String(body.name).trim();
    if (s === "") return { error: "name cannot be empty" };
    const sanitized = sanitizeString(s, { maxLen: 100 });
    if (!sanitized) return { error: "name must be 1-100 chars" };
    data.name = sanitized;
    hasField = true;
  }
  if (body.contact != null) {
    const s = sanitizeString(body.contact, { maxLen: 200, allowEmpty: true });
    // allow empty to clear
    data.contact = s ?? "";
    hasField = true;
  }
  if (body.address != null) {
    const s = sanitizeString(body.address, { maxLen: 500, allowEmpty: true });
    data.address = s ?? "";
    hasField = true;
  }
  if (body.status != null) {
    const st = String(body.status).trim();
    if (!SUPPLIER_STATUSES.includes(st)) return { error: `status must be one of ${SUPPLIER_STATUSES.join(", ")}` };
    data.status = st;
    hasField = true;
  }
  if (!hasField) return { error: "No update fields provided" };
  return { ok: true, data };
}

export function sanitizeInventoryQueryParams(searchParams) {
  const category = searchParams.get("category");
  const status = searchParams.get("status");
  const result = {};
  if (category) {
    const s = sanitizeString(category, { maxLen: 100, allowEmpty: true });
    if (s) result.category = s;
  }
  if (status) {
    const s = String(status).trim();
    if (INVENTORY_STATUSES.includes(s)) result.status = s;
  }
  return result;
}

export { INVENTORY_STATUSES, SUPPLIER_STATUSES, MOVEMENT_TYPES, MOVEMENT_REASONS };
