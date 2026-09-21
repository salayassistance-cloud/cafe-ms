import mongoose from "mongoose";
import { getInventoryAuditModel, AUDIT_ACTIONS } from "@/lib/models/InventoryAudit";

const STAFF_ROLES = ["WAITER", "KITCHEN", "BARISTA", "MANAGER"];

function isValidObjectId(id) {
  return id != null && mongoose.isValidObjectId(String(id));
}

function normalizeRole(role) {
  if (!role) return null;
  const r = String(role).trim().toUpperCase();
  return STAFF_ROLES.includes(r) ? r : null;
}

/**
 * Validate and normalize audit inputs server-side.
 * Do not trust actor identity from client — derive from authenticated session.
 * Returns { ok, data } or { error }.
 */
export function validateAuditInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Invalid audit input" };
  }
  const { itemId, action, actorId, actorRole, quantityDelta, beforeStock, afterStock, oldCost, newCost, unit, unitCost, totalCost, supplier, reason, correlationId, beforeSnapshot, afterSnapshot } = input;

  const item = String(itemId || "").trim();
  if (!item || !mongoose.isValidObjectId(item)) return { error: "itemId must be valid ObjectId" };

  const act = String(action || "").trim().toUpperCase();
  // Map legacy aliases to canonical
  const actionMap = {
    WASTE: "WASTE",
    ITEM_CREATED: "ITEM_CREATED",
    CREATE_ITEM: "ITEM_CREATED",
    CREATE: "ITEM_CREATED",
    ITEM_UPDATED: "ITEM_UPDATED",
    UPDATE_ITEM: "ITEM_UPDATED",
    UPDATE: "ITEM_UPDATED",
    COST_UPDATED: "COST_UPDATED",
    PURCHASE_RECEIVED: "PURCHASE_RECEIVED",
    PURCHASE: "PURCHASE_RECEIVED",
    RECEIVE: "PURCHASE_RECEIVED",
  };
  const normalizedAction = actionMap[act] || act;
  if (!AUDIT_ACTIONS.includes(normalizedAction)) return { error: `action must be one of ${AUDIT_ACTIONS.join(", ")}` };

  let actorOid = null;
  if (actorId != null && String(actorId).trim() !== "") {
    const sid = String(actorId).trim();
    if (!mongoose.isValidObjectId(sid)) return { error: "actorId must be valid ObjectId if provided" };
    actorOid = sid;
  }

  let role = null;
  if (actorRole != null && String(actorRole).trim() !== "") {
    role = normalizeRole(actorRole);
    if (!role) return { error: `actorRole must be one of ${STAFF_ROLES.join(", ")}` };
  }

  let qty = null;
  if (quantityDelta != null && String(quantityDelta).trim() !== "") {
    if (Array.isArray(quantityDelta) || (typeof quantityDelta === "object" && quantityDelta !== null) || typeof quantityDelta === "boolean") {
      return { error: "quantityDelta must be number if provided" };
    }
    const n = Number(quantityDelta);
    if (!Number.isFinite(n)) return { error: "quantityDelta must be finite number if provided" };
    qty = n;
  }

  let before = null;
  if (beforeStock != null && String(beforeStock).trim() !== "") {
    const n = Number(beforeStock);
    if (!Number.isFinite(n)) return { error: "beforeStock must be finite number if provided" };
    before = n;
  }
  let after = null;
  if (afterStock != null && String(afterStock).trim() !== "") {
    const n = Number(afterStock);
    if (!Number.isFinite(n)) return { error: "afterStock must be finite number if provided" };
    after = n;
  }

  let corr = null;
  if (correlationId != null && String(correlationId).trim() !== "") {
    const cid = String(correlationId).trim();
    if (!mongoose.isValidObjectId(cid)) return { error: "correlationId must be valid ObjectId if provided" };
    corr = cid;
  }

  const reasonStr = reason != null ? String(reason).trim().slice(0, 500) : "";

  // unit/unitCost/totalCost/supplier for PURCHASE_RECEIVED
  let auditUnit = null;
  if (unit != null && String(unit).trim() !== "") {
    const u = String(unit).trim().slice(0, 50).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    if (!u) return { error: "unit must be 1-50 chars if provided" };
    if (/<script/i.test(u)) return { error: "unit contains invalid characters" };
    auditUnit = u;
  }
  let auditUnitCost = null;
  if (unitCost != null && String(unitCost).trim() !== "") {
    if (Array.isArray(unitCost) || (typeof unitCost === "object" && unitCost !== null) || typeof unitCost === "boolean") {
      return { error: "unitCost must be number if provided" };
    }
    const n = Number(unitCost);
    if (!Number.isFinite(n) || n < 0) return { error: "unitCost must be finite non-negative number if provided" };
    auditUnitCost = Math.round(n * 100) / 100;
  }
  let auditTotalCost = null;
  if (totalCost != null && String(totalCost).trim() !== "") {
    if (Array.isArray(totalCost) || (typeof totalCost === "object" && totalCost !== null) || typeof totalCost === "boolean") {
      return { error: "totalCost must be number if provided" };
    }
    const n = Number(totalCost);
    if (!Number.isFinite(n) || n < 0) return { error: "totalCost must be finite non-negative number if provided" };
    auditTotalCost = Math.round(n * 100) / 100;
  }
  let auditSupplier = null;
  if (supplier != null && String(supplier).trim() !== "") {
    const s = String(supplier).trim();
    if (!/^[a-fA-F0-9]{24}$/.test(s)) return { error: "supplier must be valid ObjectId if provided" };
    auditSupplier = s;
  }

  // oldCost/newCost — validated as finite non-negative numbers, required for COST_UPDATED
  let oCost = null;
  if (oldCost != null && String(oldCost).trim() !== "") {
    if (Array.isArray(oldCost) || (typeof oldCost === "object" && oldCost !== null) || typeof oldCost === "boolean") {
      return { error: "oldCost must be number if provided" };
    }
    const n = Number(oldCost);
    if (!Number.isFinite(n) || n < 0) return { error: "oldCost must be finite non-negative number if provided" };
    oCost = Math.round(n * 100) / 100;
  }
  let nCost = null;
  if (newCost != null && String(newCost).trim() !== "") {
    if (Array.isArray(newCost) || (typeof newCost === "object" && newCost !== null) || typeof newCost === "boolean") {
      return { error: "newCost must be number if provided" };
    }
    const n = Number(newCost);
    if (!Number.isFinite(n) || n < 0) return { error: "newCost must be finite non-negative number if provided" };
    nCost = Math.round(n * 100) / 100;
  }
  if (normalizedAction === "COST_UPDATED") {
    if (oCost == null) return { error: "oldCost is required for COST_UPDATED" };
    if (nCost == null) return { error: "newCost is required for COST_UPDATED" };
    if (oCost === nCost) return { error: "oldCost and newCost must differ for COST_UPDATED" };
  }
  if (normalizedAction === "PURCHASE_RECEIVED") {
    if (qty == null) return { error: "quantityDelta is required for PURCHASE_RECEIVED" };
    if (qty <= 0) return { error: "quantityDelta must be > 0 for PURCHASE_RECEIVED" };
    if (before == null) return { error: "beforeStock is required for PURCHASE_RECEIVED" };
    if (after == null) return { error: "afterStock is required for PURCHASE_RECEIVED" };
    if (auditUnitCost == null) return { error: "unitCost is required for PURCHASE_RECEIVED" };
    if (auditTotalCost == null) return { error: "totalCost is required for PURCHASE_RECEIVED" };
    if (auditUnit != null && auditUnit.trim() === "") return { error: "unit must be non-empty if provided for PURCHASE_RECEIVED" };
  }

  // beforeSnapshot/afterSnapshot are validated as plain objects if provided, no secrets, strip prototype pollution keys
  let beforeSnap = null;
  if (beforeSnapshot != null) {
    if (typeof beforeSnapshot !== "object" || Array.isArray(beforeSnapshot)) return { error: "beforeSnapshot must be object if provided" };
    // Shallow sanitize: remove __proto__, constructor, prototype
    const out = {};
    for (const [k, v] of Object.entries(beforeSnapshot)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype" || k.startsWith("$")) continue;
      out[k] = v;
    }
    beforeSnap = out;
  }
  let afterSnap = null;
  if (afterSnapshot != null) {
    if (typeof afterSnapshot !== "object" || Array.isArray(afterSnapshot)) return { error: "afterSnapshot must be object if provided" };
    const out = {};
    for (const [k, v] of Object.entries(afterSnapshot)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype" || k.startsWith("$")) continue;
      out[k] = v;
    }
    afterSnap = out;
  }

  return {
    ok: true,
    data: {
      item: item,
      action: normalizedAction,
      actorId: actorOid,
      actorRole: role,
      quantityDelta: qty,
      beforeStock: before,
      afterStock: after,
      oldCost: oCost,
      newCost: nCost,
      unit: auditUnit,
      unitCost: auditUnitCost,
      totalCost: auditTotalCost,
      supplier: auditSupplier,
      reason: reasonStr,
      correlationId: corr,
      beforeSnapshot: beforeSnap,
      afterSnapshot: afterSnap,
    },
  };
}

/**
 * Create audit event — should be called inside same transaction/session as mutation when possible.
 * Validates server-side, derives actor from session (do not trust client).
 * Returns created doc. Throws if audit write fails (caller must abort transaction).
 */
export async function createInventoryAudit(conn, input, options = {}) {
  const validated = validateAuditInput(input);
  if (!validated.ok) {
    const err = new Error(validated.error);
    err.status = 400;
    throw err;
  }
  const data = validated.data;
  const InventoryAudit = getInventoryAuditModel(conn);

  const doc = {
    item: data.item,
    action: data.action,
    actorId: data.actorId ? new mongoose.Types.ObjectId(data.actorId) : null,
    actorRole: data.actorRole,
    quantityDelta: data.quantityDelta,
    beforeStock: data.beforeStock,
    afterStock: data.afterStock,
    oldCost: data.oldCost != null ? data.oldCost : null,
    newCost: data.newCost != null ? data.newCost : null,
    unit: data.unit != null ? data.unit : null,
    unitCost: data.unitCost != null ? data.unitCost : null,
    totalCost: data.totalCost != null ? data.totalCost : null,
    supplier: data.supplier ? new mongoose.Types.ObjectId(data.supplier) : null,
    reason: data.reason,
    correlationId: data.correlationId ? new mongoose.Types.ObjectId(data.correlationId) : null,
    beforeSnapshot: data.beforeSnapshot,
    afterSnapshot: data.afterSnapshot,
  };

  const session = options.session || null;
  if (session) {
    const [created] = await InventoryAudit.create([doc], { session });
    return created;
  }
  const created = await InventoryAudit.create(doc);
  return created;
}

export { AUDIT_ACTIONS };
