// Inventory service helpers — Phase D read-only helpers, no deduction logic.
// Reuses existing singleton pattern, no new DB connection.

export function deriveInventoryStatus(currentStock, minimumStock) {
  const cur = Number(currentStock);
  const min = Number(minimumStock);
  if (!Number.isFinite(cur) || cur <= 0) return "Out Of Stock";
  if (Number.isFinite(min) && cur <= min) return "Low Stock";
  return "In Stock";
}

export function serializeInventoryItem(doc) {
  return {
    _id: String(doc._id),
    id: String(doc._id),
    name: doc.name,
    category: doc.category,
    unit: doc.unit,
    currentStock: Number(doc.currentStock) || 0,
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
    reason: doc.reason || null,
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    refOrderId: doc.refOrderId ? String(doc.refOrderId) : null,
    notes: doc.notes || "",
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}
