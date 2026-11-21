// extraItemService.js — sellable Extra Items backed by canonical inventory.
//
// An Extra Item is a small Manager-managed wrapper around one existing
// InventoryItem. It has a display name, category, selling price, availability
// and stock association — but NO recipe. Ordering an Extra Item deducts one
// linked stock unit per selected quantity through the normal reservation and
// consumption lifecycle.
//
// Extras are always components of a parent Menu Item order line
// (PRICED_COMPONENT). They are never standalone order lines. The client sends
// only { kind: "PRICED_COMPONENT", extraItemId, quantity }; the server resolves
// name, selling price, unit, stock association and deduction quantity.

import mongoose from "mongoose";
import { getExtraItemModel } from "./models/ExtraItem.js";
import { getInventoryItemModel } from "./models/InventoryItem.js";
import { getInventoryReservationModel } from "./models/InventoryReservation.js";
import { EXTRA_ITEM_CATEGORY } from "./inventoryCategories.js";
import { normalizeUnit } from "./inventoryUnits.js";
import { getLocalizedSingleString } from "./displayName.js";
import { sanitizeString, OBJECTID_RE } from "./validate.js";

export class ExtraItemError extends Error {
  constructor(message, status = 400, code = "EXTRA_ITEM_INVALID") {
    super(message);
    this.name = "ExtraItemError";
    this.status = status;
    this.code = code;
  }
}

const QTY_EPSILON = 1e-9;

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toOid(value) {
  const text = String(value || "").trim();
  return text && mongoose.isValidObjectId(text) ? new mongoose.Types.ObjectId(text) : null;
}

export function isExtraItemAvailable(extra) {
  return !!extra && extra.isAvailable !== false;
}

// The linked stock unit must be in the canonical inventory vocabulary. We never
// guess a serving unit or silently convert an unsupported legacy unit.
export function assertSupportedStockUnit(unit, field = "unit") {
  try {
    return normalizeUnit(unit, field);
  } catch {
    throw new ExtraItemError(
      "The linked inventory unit is not supported for Extra Items",
      422,
      "EXTRA_ITEM_UNIT_UNSUPPORTED"
    );
  }
}

// Fails closed before any order write for an unknown/disabled Extra Item or a
// missing/invalid stock association.
export function assertExtraItemEligible(extra, inventoryItem) {
  if (!extra) {
    throw new ExtraItemError("Extra Item not found", 404, "EXTRA_ITEM_NOT_FOUND");
  }
  if (!isExtraItemAvailable(extra)) {
    throw new ExtraItemError(
      "Extra Item is not available for ordering",
      403,
      "EXTRA_ITEM_UNAVAILABLE"
    );
  }
  const price = Number(extra.sellingPrice);
  if (!Number.isFinite(price) || price < 0) {
    throw new ExtraItemError(
      "Extra Item has an invalid selling price",
      422,
      "EXTRA_ITEM_PRICE_INVALID"
    );
  }
  if (!inventoryItem) {
    throw new ExtraItemError(
      "Extra Item is not linked to an inventory stock item",
      409,
      "EXTRA_ITEM_INVENTORY_NOT_FOUND"
    );
  }
  assertSupportedStockUnit(inventoryItem.unit);
  return true;
}

// Server-owned picker projection. Cost, stock levels and reservation details are
// deliberately never exposed to the waiter.
export function toCatalogEntry(extra, inventoryItem) {
  assertExtraItemEligible(extra, inventoryItem);
  return {
    extraItemId: String(extra._id),
    name: extra.name || "",
    nameText: getLocalizedSingleString(extra.name) || "",
    category: extra.category || EXTRA_ITEM_CATEGORY,
    price: round2(extra.sellingPrice),
    unit: String(inventoryItem.unit).trim(),
    inventoryItemId: String(inventoryItem._id),
  };
}

// Build a fully server-authoritative PRICED_COMPONENT for one extra selection.
// `stockQuantity: 1` means one selected extra consumes exactly one unit of the
// linked InventoryItem in that item's own canonical unit.
export function buildExtraComponent(extra, inventoryItem, quantity, componentId = null) {
  assertExtraItemEligible(extra, inventoryItem);
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
    throw new ExtraItemError(
      "Extra Item quantity must be an integer 1-99",
      400,
      "EXTRA_ITEM_QUANTITY_INVALID"
    );
  }
  const unitPrice = round2(extra.sellingPrice);
  const stockUnit = String(inventoryItem.unit).trim();
  const costSnapshot = round2(inventoryItem.cost);
  return {
    componentId: componentId || new mongoose.Types.ObjectId(),
    kind: "PRICED_COMPONENT",
    note: null,
    name: sanitizeString(extra.name, { maxLen: 100 }) || String(extra.name || "").slice(0, 100),
    quantity: qty,
    unitPrice,
    lineSum: round2(qty * unitPrice),
    extraItemId: toOid(extra._id),
    inventoryItemId: toOid(inventoryItem._id),
    // One selected extra consumes one inventory unit. Unit is the exact stored
    // InventoryItem unit, never a client value.
    stockQuantity: 1,
    stockUnit,
    costSnapshot,
    totalCost: round2(qty * costSnapshot),
  };
}

// Batch-load ExtraItem + linked InventoryItem documents and resolve a list of
// normalized components. Anything invalid fails closed (typed error) before the
// caller persists the order.
export async function resolveExtraComponents(conn, components) {
  if (!Array.isArray(components) || components.length === 0) return [];
  const extraIds = [
    ...new Set(
      components
        .filter((c) => c && c.kind === "PRICED_COMPONENT" && c.extraItemId)
        .map((c) => String(c.extraItemId))
        .filter((id) => mongoose.isValidObjectId(id))
    ),
  ];
  if (extraIds.length === 0) return components;

  const ExtraItem = getExtraItemModel(conn);
  const InventoryItem = getInventoryItemModel(conn);
  const extras = await ExtraItem.find({ _id: { $in: extraIds } })
    .select("_id name category sellingPrice inventoryItemId isAvailable")
    .lean();
  const extraMap = new Map(extras.map((e) => [String(e._id), e]));

  const inventoryIds = [
    ...new Set(
      extras
        .map((e) => (e.inventoryItemId ? String(e.inventoryItemId) : ""))
        .filter((id) => mongoose.isValidObjectId(id))
    ),
  ];
  const inventoryDocs = inventoryIds.length
    ? await InventoryItem.find({ _id: { $in: inventoryIds } })
        .select("_id name unit cost currentStock reservedStock")
        .lean()
    : [];
  const inventoryMap = new Map(inventoryDocs.map((i) => [String(i._id), i]));

  return components.map((component) => {
    if (!component || component.kind !== "PRICED_COMPONENT") return component;
    const extra = extraMap.get(String(component.extraItemId));
    const inventory = extra?.inventoryItemId
      ? inventoryMap.get(String(extra.inventoryItemId))
      : null;
    return buildExtraComponent(
      extra,
      inventory,
      component.quantity,
      component.componentId
    );
  });
}

// Read-only picker catalog. Unavailable extras, missing stock links and
// unsupported units are omitted so the waiter can never select an item that the
// server would later reject.
export async function listExtraItemCatalog(conn) {
  const ExtraItem = getExtraItemModel(conn);
  const extras = await ExtraItem.find({ isAvailable: { $ne: false } })
    .select("_id name category sellingPrice inventoryItemId isAvailable")
    .lean();
  if (extras.length === 0) return [];

  const inventoryIds = [
    ...new Set(
      extras
        .map((e) => (e.inventoryItemId ? String(e.inventoryItemId) : ""))
        .filter((id) => mongoose.isValidObjectId(id))
    ),
  ];
  const InventoryItem = getInventoryItemModel(conn);
  const inventoryDocs = inventoryIds.length
    ? await InventoryItem.find({ _id: { $in: inventoryIds } })
        .select("_id name unit cost currentStock reservedStock")
        .lean()
    : [];
  const inventoryMap = new Map(inventoryDocs.map((i) => [String(i._id), i]));

  const entries = [];
  for (const extra of extras) {
    const inventory = inventoryMap.get(String(extra.inventoryItemId));
    if (!inventory) continue;
    try {
      entries.push(toCatalogEntry(extra, inventory));
    } catch {
      // Invalid stock association/unit — hide it instead of offering an item
      // that would fail at order time.
    }
  }
  return entries.sort((a, b) => a.nameText.localeCompare(b.nameText));
}

// Manager listing (includes unavailable items) with a read-only stock snapshot.
export async function listExtraItems(conn) {
  const ExtraItem = getExtraItemModel(conn);
  const InventoryItem = getInventoryItemModel(conn);
  const extras = await ExtraItem.find({}).sort({ name: 1 }).lean();
  const inventoryIds = [
    ...new Set(
      extras
        .map((e) => (e.inventoryItemId ? String(e.inventoryItemId) : ""))
        .filter((id) => mongoose.isValidObjectId(id))
    ),
  ];
  const inventoryDocs = inventoryIds.length
    ? await InventoryItem.find({ _id: { $in: inventoryIds } })
        .select("_id name unit cost currentStock reservedStock stockGroup")
        .lean()
    : [];
  const inventoryMap = new Map(inventoryDocs.map((i) => [String(i._id), i]));
  return extras.map((extra) => serializeExtraItem(extra, inventoryMap.get(String(extra.inventoryItemId))));
}

export function serializeExtraItem(extra, inventoryItem = null) {
  return {
    _id: String(extra._id),
    id: String(extra._id),
    name: extra.name || "",
    category: extra.category || EXTRA_ITEM_CATEGORY,
    sellingPrice: round2(extra.sellingPrice),
    inventoryItemId: extra.inventoryItemId ? String(extra.inventoryItemId) : null,
    isAvailable: extra.isAvailable !== false,
    inventory: inventoryItem
      ? {
          _id: String(inventoryItem._id),
          name: inventoryItem.name || "",
          unit: inventoryItem.unit || null,
          stockGroup: inventoryItem.stockGroup || null,
          currentStock: Number(inventoryItem.currentStock) || 0,
          reservedStock: Number(inventoryItem.reservedStock) || 0,
        }
      : null,
    createdAt: extra.createdAt ? new Date(extra.createdAt).toISOString() : null,
    updatedAt: extra.updatedAt ? new Date(extra.updatedAt).toISOString() : null,
  };
}

// Validate Manager CRUD payloads. Partial updates only require the fields that
// are present. `inventoryItemId` must be an ObjectId; existence is checked by
// the route against the live InventoryItem collection.
export function validateExtraItemPayload(body, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body" };
  }
  const data = {};
  let hasField = false;

  if (body.name !== undefined || !partial) {
    const name = sanitizeString(body.name, { maxLen: 100 });
    if (!name) return { error: "name is required (max 100 chars)" };
    if (/<script/i.test(name) || /javascript:/i.test(name) || /on\w+\s*=/i.test(name)) {
      return { error: "name contains invalid characters" };
    }
    data.name = name;
    hasField = true;
  }

  if (body.category !== undefined) {
    const category = sanitizeString(body.category, { maxLen: 100 });
    if (!category) return { error: "category must be 1-100 chars" };
    data.category = category;
    hasField = true;
  } else if (!partial) {
    data.category = EXTRA_ITEM_CATEGORY;
  }

  if (body.sellingPrice !== undefined || !partial) {
    const price = Number(body.sellingPrice);
    if (!Number.isFinite(price) || price < 0 || price > 100000) {
      return { error: "sellingPrice must be a number 0-100000" };
    }
    data.sellingPrice = round2(price);
    hasField = true;
  }

  if (body.inventoryItemId !== undefined || !partial) {
    const inventoryItemId = String(body.inventoryItemId || "").trim();
    if (!OBJECTID_RE.test(inventoryItemId)) {
      return { error: "inventoryItemId must be a valid ObjectId" };
    }
    data.inventoryItemId = inventoryItemId;
    hasField = true;
  }

  if (body.isAvailable !== undefined) {
    if (typeof body.isAvailable !== "boolean") {
      return { error: "isAvailable must be a boolean" };
    }
    data.isAvailable = body.isAvailable;
    hasField = true;
  }

  if (partial && !hasField) {
    return { error: "No update fields provided (need name, category, sellingPrice, inventoryItemId, isAvailable)" };
  }
  return { ok: true, data };
}

// Stock item ids referenced by extra components on an order. Only components
// created through the Extra Item catalog carry `extraItemId`; historical
// manual priced components are ignored here (they remain read-only history).
export function collectExtraStockItemIds(items) {
  const ids = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const components = Array.isArray(item?.components) ? item.components : [];
    for (const component of components) {
      if (
        component &&
        component.kind === "PRICED_COMPONENT" &&
        component.extraItemId &&
        component.inventoryItemId
      ) {
        ids.add(String(component.inventoryItemId));
      }
    }
  }
  return ids;
}

export function hasExtraComponents(items) {
  return collectExtraStockItemIds(items).size > 0;
}

// Fail closed when an extra-linked reservation row is short. Callers create the
// reservation before persisting the order; on failure they release it and never
// write the order.
export async function assertExtraStockReserved(conn, orderOrId) {
  const orderId = toOid(
    typeof orderOrId === "object" ? orderOrId?._id || orderOrId?.id : orderOrId
  );
  if (!orderId) {
    throw new ExtraItemError("Order id is required", 400, "EXTRA_ITEM_ORDER_INVALID");
  }
  const items = typeof orderOrId === "object" ? orderOrId?.items : null;
  const extraStockIds = collectExtraStockItemIds(items);
  if (extraStockIds.size === 0) return null;

  const Reservation = getInventoryReservationModel(conn);
  const reservation = await Reservation.findOne({ orderId }).lean();
  if (!reservation) {
    throw new ExtraItemError(
      "Extra Item stock could not be reserved. Please retry shortly.",
      503,
      "EXTRA_ITEM_RESERVATION_UNAVAILABLE"
    );
  }
  const shortages = (Array.isArray(reservation.items) ? reservation.items : []).filter(
    (row) =>
      extraStockIds.has(String(row.inventoryItemId)) &&
      Number(row.shortageQuantity) > QTY_EPSILON
  );
  if (shortages.length > 0) {
    throw new ExtraItemError(
      "Insufficient stock for the selected Extra Item",
      409,
      "EXTRA_ITEM_INSUFFICIENT_STOCK"
    );
  }
  return reservation;
}
