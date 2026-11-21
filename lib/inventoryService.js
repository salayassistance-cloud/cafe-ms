// Inventory service helpers — Phase D read-only helpers, no deduction logic.
// Reuses existing singleton pattern, no new DB connection.

import { availableStockOf } from "./inventoryStatus.js";

// Sellable stock excludes quantities held by live orders, so status is derived
// from availableStock (currentStock - reservedStock), never physical stock alone.
// The derivation lives in lib/inventoryStatus so the Manager UI renders exactly
// the same rule the API applies — one implementation, no drift.
export { deriveInventoryStatus } from "./inventoryStatus.js";

export function serializeInventoryItem(doc) {
  return {
    _id: String(doc._id),
    id: String(doc._id),
    name: doc.name,
    category: doc.category,
    stockGroup: doc.stockGroup || null,
    unit: doc.unit,
    currentStock: Number(doc.currentStock) || 0,
    reservedStock: Number(doc.reservedStock) || 0,
    availableStock: Math.max(0, availableStockOf(doc.currentStock, doc.reservedStock)),
    minimumStock: Number(doc.minimumStock) || 0,
    cost: Number(doc.cost) || 0,
    supplier: doc.supplier ? String(doc.supplier) : null,
    status: doc.status,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

export function serializeSupplier(doc) {
  return {
    _id: String(doc._id),
    id: String(doc._id),
    name: doc.name,
    contact: doc.contact || "",
    address: doc.address || "",
    status: doc.status,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

export function serializeMovement(doc) {
  return {
    _id: String(doc._id),
    id: String(doc._id),
    item: doc.item ? String(doc.item) : null,
    type: doc.type,
    quantity: Number(doc.quantity),
    unit: doc.unit || null,
    unitCost: doc.unitCost != null && Number.isFinite(Number(doc.unitCost)) ? Number(doc.unitCost) : null,
    totalCost: doc.totalCost != null && Number.isFinite(Number(doc.totalCost)) ? Number(doc.totalCost) : null,
    reason: doc.reason || null,
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    refOrderId: doc.refOrderId ? String(doc.refOrderId) : null,
    voidedAt: doc.voidedAt ? new Date(doc.voidedAt).toISOString() : null,
    voidReason: doc.voidReason || null,
    voidedBy: doc.voidedBy ? String(doc.voidedBy) : null,
    notes: doc.notes || "",
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}
