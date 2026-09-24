import mongoose from "mongoose";
import { getOrderModel, ITEM_TYPE } from "@/lib/models/Order";
import { VALID_PAYMENT_METHODS } from "@/lib/constants";
import { getLocalizedSingleString } from "@/lib/displayName";

// Shared business logic for the unified order pipeline: creation (with price
// snapshotting from the MenuItem catalog), status updates (whole-ticket prep
// phase), and the KDS projection used by the real-time stream.
// Auditable: every order is locked to waiterId/waiterName and records
// kitchenStaffId/baristaStaffId on READY for manager reporting.

// Monotonic counter for human-friendly, strictly increasing order numbers
// (ORD-1001, ORD-1002, …) stored on the dedicated orders connection.
const counterSchema = new mongoose.Schema(
  { _id: String, seq: { type: Number, default: 0 } },
  { collection: "counters" }
);

function getCounterModel(connection) {
  return (
    connection.models.OrderCounter ||
    connection.model("OrderCounter", counterSchema, "counters")
  );
}

// Auto-generated, human-friendly, strictly increasing order number (ORD-1001…).
// Falls back to a time-based unique id if the counter collection is unreachable.
async function genOrderNumber(conn) {
  try {
    const Counter = getCounterModel(conn);
    const doc = await Counter.findOneAndUpdate(
      { _id: "order_seq" },
      { $inc: { seq: 1 } },
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
        maxTimeMS: 2000,
      }
    );
    return `ORD-${1000 + doc.seq}`;
  } catch {
    return `ORD-${Date.now().toString(36).toUpperCase()}`;
  }
}

// Accept either the canonical shape ({ name, price, quantity, type, itemId }) or the
// legacy Waiter-UI payload ({ title, price, quantity/qty, barista, category }).
// Server will override type/price from catalog when itemId resolves — client type is not authoritative.
function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;

  const name = getLocalizedSingleString(raw.name).trim() || getLocalizedSingleString(raw.title).trim();
  if (!name) return null;

  const price = Number(raw.price);
  const quantity = Number(raw.quantity ?? raw.qty);
  if (!Number.isFinite(price) || price < 0) return null;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return null;

  // Client type is a hint only — server will resolve canonical type from MenuItem when itemId present.
  const type = ITEM_TYPE.includes(raw.type)
    ? raw.type
    : raw.barista === true || String(raw.category).toUpperCase() === "DRINK"
    ? "DRINK"
    : "FOOD";

  let itemId = null;
  if (raw.itemId && mongoose.isValidObjectId(String(raw.itemId))) itemId = String(raw.itemId);
  else if (raw._id && mongoose.isValidObjectId(String(raw._id))) itemId = String(raw._id);

  const isExternal = raw.isExternal === true;

  // Components attached to this parent item — not standalone orders
  const rawComps = Array.isArray(raw.components) ? raw.components : [];
  const components = [];
  if (rawComps.length > 20) return null; // prevent abuse: max 20 components per item
  for (let ci = 0; ci < rawComps.length; ci++) {
    const comp = normalizeComponent(rawComps[ci], ci);
    if (!comp) return null; // strict: any invalid component rejects whole item
    components.push(comp);
  }

  return {
    name,
    price: Math.round(price * 100) / 100,
    quantity,
    type,
    itemId,
    isExternal,
    components,
  };
}

// Component normalization — two explicit types, server-validated, no trusted client totals
function normalizeComponent(raw, idx) {
  if (!raw || typeof raw !== "object") return null;
  const kindRaw = String(raw.kind || raw.type || "").trim().toUpperCase();
  // Accept aliases: NOTE, INGREDIENT, INSTRUCTION, PRICED, PRICED_COMPONENT, EXTRA
  let kind = null;
  if (kindRaw === "NOTE" || kindRaw === "INGREDIENT" || kindRaw === "INSTRUCTION" || kindRaw === "INGREDIENT_NOTE") kind = "NOTE";
  else if (kindRaw === "PRICED_COMPONENT" || kindRaw === "PRICED" || kindRaw === "EXTRA" || kindRaw === "COMPONENT") kind = "PRICED_COMPONENT";
  else return null; // unknown kind

  if (kind === "NOTE") {
    const noteRaw = raw.note ?? raw.text ?? raw.instruction ?? "";
    const note = typeof noteRaw === "string" ? noteRaw.trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") : "";
    if (!note) return null;
    if (note.length > 500) return null;
    if (/<script/i.test(note) || /javascript:/i.test(note) || /on\w+\s*=/i.test(note)) return null;
    return {
      componentId: new mongoose.Types.ObjectId(),
      kind: "NOTE",
      note: note.slice(0, 500),
      // No price, no inventory
      name: null,
      quantity: null,
      unitPrice: null,
      lineSum: null,
      inventoryItemId: null,
      stockQuantity: null,
      stockUnit: null,
      costSnapshot: null,
      totalCost: null,
    };
  }

  // PRICED_COMPONENT
  const nameRaw = raw.name ?? raw.title ?? "";
  const name = typeof nameRaw === "string" ? nameRaw.trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") : "";
  if (!name) return null;
  if (name.length > 100) return null;
  if (/<script/i.test(name) || /javascript:/i.test(name)) return null;
  const qtyRaw = raw.quantity ?? raw.qty;
  const quantity = Number(qtyRaw);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return null;
  const priceRaw = raw.unitPrice ?? raw.price ?? raw.unit_price;
  const unitPrice = Number(priceRaw);
  if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 100000) return null;
  const roundedPrice = Math.round(unitPrice * 100) / 100;
  const lineSum = Math.round(quantity * roundedPrice * 100) / 100;

  // Optional inventory link — validated but not required. If present, must be valid ObjectId
  let inventoryItemId = null;
  if (raw.inventoryItemId != null && String(raw.inventoryItemId).trim() !== "") {
    const oid = String(raw.inventoryItemId).trim();
    if (!mongoose.isValidObjectId(oid)) return null;
    inventoryItemId = new mongoose.Types.ObjectId(oid);
  } else if (raw.inventoryId != null && String(raw.inventoryId).trim() !== "") {
    const oid = String(raw.inventoryId).trim();
    if (!mongoose.isValidObjectId(oid)) return null;
    inventoryItemId = new mongoose.Types.ObjectId(oid);
  }

  let stockQuantity = null;
  let stockUnit = null;
  if (inventoryItemId) {
    // If linked to inventory, require valid stock consumption quantity/unit
    const sqRaw = raw.stockQuantity ?? raw.consumptionQty ?? raw.qtyStock;
    const sq = Number(sqRaw);
    if (sqRaw != null && String(sqRaw).trim() !== "") {
      if (!Number.isFinite(sq) || sq <= 0 || sq > 100000) return null;
      stockQuantity = Math.round(sq * 1000) / 1000;
    } else {
      // No explicit stockQuantity -> no deduction; treat as missing link (still billable but no inventory)
      stockQuantity = null;
    }
    const suRaw = raw.stockUnit ?? raw.unit ?? raw.consumptionUnit;
    if (suRaw != null && String(suRaw).trim() !== "") {
      const su = String(suRaw).trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, 20);
      if (!su) return null;
      stockUnit = su;
    } else if (stockQuantity != null) {
      return null; // stockQuantity without unit is invalid
    }
  } else {
    // No inventory link — ensure no stock fields leaked
    if (raw.stockQuantity != null || raw.stockUnit != null) return null;
  }

  return {
    componentId: new mongoose.Types.ObjectId(),
    kind: "PRICED_COMPONENT",
    note: null,
    name: name.slice(0, 100),
    quantity,
    unitPrice: roundedPrice,
    lineSum,
    inventoryItemId,
    stockQuantity,
    stockUnit,
    costSnapshot: null, // filled server-side from inventory cost source
    totalCost: null,
  };
}

// Server-authoritative catalog snapshot for one order line (shared by
// createOrder and editOrderItems — single implementation, not duplicated).
// Price/name/type come from the MenuItem doc when it resolves; otherwise the
// caller-supplied values are used. Routing priority:
// cat.categoryType > cat.targetStation/station > client type.
function resolveCatalogLine(cat, fallback) {
  const price =
    cat && Number.isFinite(Number(cat.price))
      ? Math.round(Number(cat.price) * 100) / 100
      : fallback.price;
  // Catalog names are LocalizedString objects — flatten to a plain string so
  // React never receives an object as a JSX child.
  const name = getLocalizedSingleString(cat?.name) || fallback.name;
  let type = fallback.type;
  if (cat) {
    if (cat.categoryType && ITEM_TYPE.includes(cat.categoryType)) type = cat.categoryType;
    else if (cat.targetStation === "BARISTA" || cat.station === "BARISTA") type = "DRINK";
    else if (cat.targetStation === "KITCHEN" || cat.station === "KITCHEN") type = "FOOD";
  }
  return { price, name, type };
}

// Create an order. Prices are snapshotted from the MenuItem catalog when the
// submitted itemId resolves; otherwise the caller-supplied price is used. This
// keeps the spec's "fetch current price from MenuItem DB" behaviour while still
// accepting waiter-submitted prices.
// Auditable: caller SHOULD pass waiterId/waiterName from the authenticated
// session (see /api/orders POST). If waiterId is a valid ObjectId it is stored
// as FK to Staff; otherwise stored as null for legacy orders.
export async function createOrder(conn, payload) {
  const tableNumber = Number(payload?.tableNumber);
  const waiterName =
    typeof payload?.waiterName === "string" && payload.waiterName.trim()
      ? payload.waiterName.trim().slice(0, 50)
      : "Waiter";
  const waiterNumber =
    Number.isInteger(Number(payload?.waiterNumber)) &&
    Number(payload?.waiterNumber) >= 1 &&
    Number(payload?.waiterNumber) <= 10
      ? Number(payload.waiterNumber)
      : null;
  // waiterId: prefer explicit ObjectId, else derive from waiterInfo.waiterId
  let waiterId = null;
  const rawId = payload?.waiterId ?? payload?.waiterInfo?.waiterId ?? null;
  if (rawId && mongoose.isValidObjectId(String(rawId))) {
    waiterId = new mongoose.Types.ObjectId(String(rawId));
  }

  // Unified waiter identity: prefer an explicit `waiterInfo` payload, otherwise
  // derive a minimal one from the top-level waiterNumber. Null/legacy-safe.
  const rawInfo = payload?.waiterInfo;
  const waiterInfo = {
    waiterId:
      rawInfo && rawInfo.waiterId != null ? String(rawInfo.waiterId) : waiterId ? String(waiterId) : null,
    waiterNumber:
      rawInfo && Number.isInteger(Number(rawInfo.waiterNumber))
        ? Number(rawInfo.waiterNumber)
        : waiterNumber,
    shiftId:
      rawInfo && typeof rawInfo && typeof rawInfo.shiftId === "string" && rawInfo.shiftId
        ? rawInfo.shiftId
        : "SHIFT-DEFAULT",
    deviceId:
      rawInfo && typeof rawInfo.deviceId === "string" && rawInfo.deviceId
        ? rawInfo.deviceId
        : "DEVICE-UNKNOWN",
  };

  if (!Number.isInteger(tableNumber)) {
    throw new Error("tableNumber is required and must be a number");
  }

  let items = (Array.isArray(payload?.items) ? payload.items : [])
    .map(normalizeItem)
    .filter(Boolean);

  if (items.length === 0) {
    throw new Error("Order must contain at least one valid item");
  }

  // Batch-fetch the catalog entries referenced by itemId for price/type snapshotting.
  // Routing is SERVER-AUTHORITATIVE: canonical type comes from MenuItem doc (categoryType/station/targetStation), not client.
  const ids = items
    .map((i) => i.itemId)
    .filter((id) => mongoose.isValidObjectId(id));
  const snapshot = new Map();
  if (ids.length) {
    try {
      const { getMenuItemModel } = await import("@/lib/models/MenuItem");
      const MenuItem = getMenuItemModel(conn);
      const found = await MenuItem.find({ _id: { $in: ids } }).lean();
      for (const m of found) snapshot.set(String(m._id), m);
    } catch {
      // Menu catalog unavailable — fall back to submitted prices.
    }
  }
  items = items.map((it) => {
    const cat = it.itemId ? snapshot.get(String(it.itemId)) : null;
    // Server-authoritative price/name/type snapshot (single shared helper below).
    const { price, name, type } = resolveCatalogLine(cat, it);
    const itemId = cat ? new mongoose.Types.ObjectId(String(cat._id)) : (it.itemId ? new mongoose.Types.ObjectId(String(it.itemId)) : null);
    const lineId = new mongoose.Types.ObjectId();
    // Preserve components attached to this parent item — will enrich costSnapshot below
    const rawComponents = Array.isArray(it.components) ? it.components : [];
    // Clone components to avoid mutating original; costSnapshot will be filled after inventory fetch
    const components = rawComponents.map((c) => ({ ...c }));
    return { lineId, name, price, quantity: it.quantity, type, isExternal: !!it.isExternal, cancelled: false, cancelledAt: null, cancelledBy: null, cancelledStation: null, cancelReason: null, components, ...(itemId ? { itemId } : {}) };
  });

  // For priced components linked to inventory, fetch real cost snapshot and compute totalCost
  // Manual selling price (unitPrice) is NOT cost; costSnapshot is inventory cost per stockUnit
  const pricedWithInventory = [];
  for (const it of items) {
    for (const comp of it.components || []) {
      if (comp.kind === "PRICED_COMPONENT" && comp.inventoryItemId) pricedWithInventory.push(comp);
    }
  }
  if (pricedWithInventory.length > 0) {
    const invIds = [...new Set(pricedWithInventory.map((c) => String(c.inventoryItemId)))].filter((id) => mongoose.isValidObjectId(id));
    if (invIds.length > 0) {
      try {
        const { getInventoryItemModel } = await import("@/lib/models/InventoryItem");
        const InventoryItem = getInventoryItemModel(conn);
        const invDocs = await InventoryItem.find({ _id: { $in: invIds } }).select("cost unit").lean();
        const costMap = new Map(invDocs.map((d) => [String(d._id), { cost: Number(d.cost) || 0, unit: String(d.unit).trim() }]));
        for (const comp of pricedWithInventory) {
          const key = String(comp.inventoryItemId);
          const info = costMap.get(key);
          if (!info) {
            // No valid inventory record — explicit missing mapping, do not fabricate cost/deduction
            comp.costSnapshot = null;
            comp.totalCost = null;
            continue;
          }
          // Validate stockUnit matches inventory unit if both present (case-insensitive)
          if (comp.stockUnit && info.unit && comp.stockUnit.toLowerCase() !== info.unit.toLowerCase()) {
            // Mismatch — treat as missing mapping, prevent false inventory reporting
            comp.costSnapshot = null;
            comp.totalCost = null;
            continue;
          }
          const cost = Math.round((Number(info.cost) || 0) * 100) / 100;
          comp.costSnapshot = cost;
          // totalCost = stockQuantity * quantity * costSnapshot (stockQuantity is per component unit)
          if (comp.stockQuantity != null && Number.isFinite(comp.stockQuantity) && comp.stockQuantity > 0) {
            const total = comp.stockQuantity * comp.quantity * cost;
            comp.totalCost = Math.round(total * 100) / 100;
          } else {
            comp.totalCost = null; // no consumption qty -> no cost/deduction
          }
        }
      } catch {
        // Inventory unavailable — leave costSnapshot null, no deduction, explicit missing
        for (const comp of pricedWithInventory) {
          if (comp.costSnapshot === undefined) {
            comp.costSnapshot = null;
            comp.totalCost = null;
          }
        }
      }
    }
  }

  const totalAmount =
    Math.round(
      items.reduce((sum, it) => {
        const base = (Number(it.price) || 0) * (Number(it.quantity) || 0);
        const compSum = (it.components || [])
          .filter((c) => c.kind === "PRICED_COMPONENT")
          .reduce((s, c) => s + (Number(c.lineSum) || 0), 0);
        return sum + base + compSum;
      }, 0) * 100
    ) / 100;

  const paymentMethod = VALID_PAYMENT_METHODS.includes(payload?.paymentMethod)
    ? payload.paymentMethod
    : "NONE";

  const hasFood = items.some((i) => i.type === "FOOD");
  const hasDrink = items.some((i) => i.type === "DRINK");
  const Order = getOrderModel(conn);
  const doc = new Order({
    orderNumber: await genOrderNumber(conn),
    tableNumber,
    waiterName,
    waiterId,
    waiterNumber,
    waiterInfo,
    // kitchen/barista IDs are set only on READY transition
    kitchenStaffId: null,
    baristaStaffId: null,
    status: "PENDING",
    kitchenStatus: hasFood ? "PENDING" : null,
    baristaStatus: hasDrink ? "PENDING" : null,
    kitchenPreparingAt: null,
    kitchenReadyAt: null,
    baristaPreparingAt: null,
    baristaReadyAt: null,
    items,
    totalAmount,
    paymentMethod,
  });

  await doc.save();
  return doc;
}

function buildOrderQuery(identifier) {
  return mongoose.isValidObjectId(identifier)
    ? { $or: [{ orderNumber: identifier }, { _id: identifier }] }
    : { orderNumber: identifier };
}

// Selective atomic update: touches ONLY the supplied fields via MongoDB $set
// and deliberately skips full-document re-validation (runValidators: false).
// Legacy orders may store items[].name as a LocalizedString object
// { am, en, om } (or lack quantity/price), so a full doc.save() would reject
// the write even though the target fields are untouched and valid. Payment
// settlements and status transitions must never fail because of pre-existing
// legacy item shapes.
async function updateOrderFields(conn, identifier, fields) {
  const Order = getOrderModel(conn);
  return Order.findOneAndUpdate(
    buildOrderQuery(identifier),
    { $set: { ...fields, updatedAt: new Date() } },
    { returnDocument: "after", runValidators: false }
  );
}

// Strict state machine for the prep-phase transitions (PENDING -> PREPARING ->
// READY). SERVED / PAID / CANCELLED are handled by serveOrder / payOrder /
// cancelOrder — they are intentionally NOT reachable from here.
// Per-station lifecycle: Kitchen may only affect FOOD (kitchenStatus), Barista only DRINK (baristaStatus).
// Overall order.status is derived: for mixed orders READY only when BOTH stations READY (or non-applicable).
// When status is READY, caller may pass kitchenStaffId / baristaStaffId or
// generic staffId+staffRole to record who marked the ticket ready (auditable).
// waiterId NEVER changes during preparation — enforced by only touching station fields.
export async function updateOrderStatus(conn, identifier, status, opts = {}) {
  if (!["PENDING", "PREPARING", "READY"].includes(status)) {
    throw new Error("Invalid prep status");
  }

  const Order = getOrderModel(conn);
  const now = new Date();
  const IS_READY = status === "READY";
  const toOid = (id) =>
    id && mongoose.isValidObjectId(String(id))
      ? new mongoose.Types.ObjectId(String(id))
      : null;

  const role = String(opts.staffRole || opts.role || "").toUpperCase();
  const isKitchen = role === "KITCHEN";
  const isBarista = role === "BARISTA";
  const isManager = role === "MANAGER";

  // Canonical strict sequence per station: PENDING -> PREPARING -> READY.
  // A pre-read classifies early with exact errors; the atomic filter below
  // repeats every guard (terminal + active lines + expected station state) so a
  // concurrent change misses cleanly into the miss-path instead of corrupting.
  const pre = await Order.findOne(buildOrderQuery(identifier))
    .select("status items kitchenStatus baristaStatus")
    .lean();
  if (!pre) throw new Error("Order not found");
  if (["SERVED", "PAYMENT_PENDING", "PAID", "CANCELLED", "ARCHIVED"].includes(pre.status)) {
    throw new Error("Order is in a terminal state");
  }
  const preHasFood = (pre.items || []).some((i) => i.type === "FOOD" && !i.cancelled);
  const preHasDrink = (pre.items || []).some((i) => i.type === "DRINK" && !i.cancelled);
  if (isKitchen && !preHasFood) throw new Error("Cannot update order: order has no active FOOD items for Kitchen");
  if (isBarista && !preHasDrink) throw new Error("Cannot update order: order has no active DRINK items for Barista");
  // Stations this request will touch (manager/no-role: every active station).
  const touched = [];
  if (isKitchen) touched.push("kitchen");
  else if (isBarista) touched.push("barista");
  else {
    if (preHasFood) touched.push("kitchen");
    if (preHasDrink) touched.push("barista");
  }
  const stationLabelOf = (s) => (s === "kitchen" ? "KITCHEN" : "BARISTA");
  const currentOf = (s) => (s === "kitchen" ? pre.kitchenStatus : pre.baristaStatus);
  for (const s of touched) {
    const cur = currentOf(s) ?? null;
    if (status === "READY") {
      if (cur !== "PREPARING") {
        throw new Error(`Invalid READY request for ${stationLabelOf(s)}: station is ${cur ?? "PENDING"}`);
      }
    } else if (cur !== null && cur !== "PENDING") {
      // PREPARING and PENDING requests require a not-started station.
      throw new Error(`Invalid ${status} request for ${stationLabelOf(s)}: station is ${cur}`);
    }
  }

  // --- Single atomic update (was Order.findOne + findOneAndUpdate = 2 round trips) ---
  // All derived fields are computed inside the DB with an aggregation pipeline,
  // so the prep-status PATCH performs exactly one order write. Error semantics
  // and per-station / terminal-state behavior are preserved exactly.
  // Station authority requires an ACTIVE line of that station: element-scoped
  // $elemMatch (type + not-cancelled on the SAME element). A top-level
  // "items.cancelled": { $ne: true } must NOT be used here (array-predicate bug:
  // it means "no element equals true"); neither may a bare "items.type" match,
  // which a cancelled-only station would still satisfy.
  const stationMatch = isKitchen
    ? { type: "FOOD", cancelled: { $ne: true } }
    : isBarista
      ? { type: "DRINK", cancelled: { $ne: true } }
      : null;
  const filter = {
    ...buildOrderQuery(identifier),
    status: { $nin: ["SERVED", "PAYMENT_PENDING", "PAID", "CANCELLED", "ARCHIVED"] },
    ...(stationMatch ? { items: { $elemMatch: stationMatch } } : {}),
  };
  // Race-proof the strict sequence: the expected pre-write station state is part
  // of the atomic filter, so a concurrent station transition misses cleanly.
  for (const s of touched) {
    const key = s === "kitchen" ? "kitchenStatus" : "baristaStatus";
    filter[key] = status === "READY" ? "PREPARING" : { $in: [null, "PENDING"] };
  }

  // Station update flags — mirror original branching.
  let updateKitchenExpr;
  let updateBaristaExpr;
  if (isKitchen) {
    updateKitchenExpr = true;
    updateBaristaExpr = false;
  } else if (isBarista) {
    updateKitchenExpr = false;
    updateBaristaExpr = true;
  } else {
    // Manager OR no-role fallback: update relevant station(s); if neither
    // food nor drink present, update both (legacy behavior).
    const hasNeither = { $and: [{ $not: "$__hasFood" }, { $not: "$__hasDrink" }] };
    updateKitchenExpr = { $or: ["$__hasFood", hasNeither] };
    updateBaristaExpr = { $or: ["$__hasDrink", hasNeither] };
  }

  // Overall status expression (uses already-updated station statuses).
  let mixedOverall;
  if (status === "PENDING") mixedOverall = "PENDING";
  else if (status === "PREPARING") mixedOverall = "PREPARING";
  else {
    mixedOverall = {
      $cond: [
        {
          $and: [
            { $eq: ["$kitchenStatus", "READY"] },
            { $eq: ["$baristaStatus", "READY"] },
          ],
        },
        "READY",
        "PREPARING",
      ],
    };
  }
  const overallExpr = {
    $cond: [{ $and: ["$__hasFood", "$__hasDrink"] }, mixedOverall, status],
  };

  const hasFoodExpr = {
    $anyElementTrue: {
      $map: {
        input: { $ifNull: ["$items", []] },
        as: "it",
        in: { $and: [{ $eq: ["$$it.type", "FOOD"] }, { $ne: ["$$it.cancelled", true] }] },
      },
    },
  };
  const hasDrinkExpr = {
    $anyElementTrue: {
      $map: {
        input: { $ifNull: ["$items", []] },
        as: "it",
        in: { $and: [{ $eq: ["$$it.type", "DRINK"] }, { $ne: ["$$it.cancelled", true] }] },
      },
    },
  };

  // READY attribution (auditable, never overwrites existing).
  const kExplicitOid = toOid(opts.kitchenStaffId);
  const bExplicitOid = toOid(opts.baristaStaffId);
  const sOid = toOid(opts.staffId);
  let kRoleOid = null;
  let kRoleShouldSet = false;
  if (isKitchen) {
    kRoleOid = role === "KITCHEN" ? sOid : null;
    kRoleShouldSet = true;
  } else if (isManager) {
    kRoleOid = role === "MANAGER" ? sOid : null;
    kRoleShouldSet = "$__updateKitchen";
  }
  let bRoleOid = null;
  let bRoleShouldSet = false;
  if (isBarista) {
    bRoleOid = role === "BARISTA" ? sOid : null;
    bRoleShouldSet = true;
  } else if (isManager) {
    bRoleOid = role === "MANAGER" ? sOid : null;
    bRoleShouldSet = "$__updateBarista";
  }
  const kCandidate = kExplicitOid || kRoleOid;
  const bCandidate = bExplicitOid || bRoleOid;
  const kShouldSet = kExplicitOid ? true : kRoleShouldSet;
  const bShouldSet = bExplicitOid ? true : bRoleShouldSet;

  const kAttrExpr = {
    $cond: [
      {
        $and: [
          kShouldSet,
          { $ne: [kCandidate, null] },
          { $eq: [{ $ifNull: ["$kitchenStaffId", null] }, null] },
        ],
      },
      kCandidate,
      "$kitchenStaffId",
    ],
  };
  const bAttrExpr = {
    $cond: [
      {
        $and: [
          bShouldSet,
          { $ne: [bCandidate, null] },
          { $eq: [{ $ifNull: ["$baristaStaffId", null] }, null] },
        ],
      },
      bCandidate,
      "$baristaStaffId",
    ],
  };

  const pipeline = [
    { $set: { __hasFood: hasFoodExpr, __hasDrink: hasDrinkExpr } },
    { $set: { __updateKitchen: updateKitchenExpr, __updateBarista: updateBaristaExpr } },
    {
      $set: {
        kitchenStatus: { $cond: ["$__updateKitchen", status, "$kitchenStatus"] },
        baristaStatus: { $cond: ["$__updateBarista", status, "$baristaStatus"] },
        kitchenPreparingAt: {
          $cond: [
            {
              $and: [
                "$__updateKitchen",
                { $eq: [status, "PREPARING"] },
                { $eq: [{ $ifNull: ["$kitchenPreparingAt", null] }, null] },
              ],
            },
            now,
            "$kitchenPreparingAt",
          ],
        },
        kitchenReadyAt: {
          $cond: [
            {
              $and: [
                "$__updateKitchen",
                { $eq: [status, "READY"] },
                { $eq: [{ $ifNull: ["$kitchenReadyAt", null] }, null] },
              ],
            },
            now,
            "$kitchenReadyAt",
          ],
        },
        baristaPreparingAt: {
          $cond: [
            {
              $and: [
                "$__updateBarista",
                { $eq: [status, "PREPARING"] },
                { $eq: [{ $ifNull: ["$baristaPreparingAt", null] }, null] },
              ],
            },
            now,
            "$baristaPreparingAt",
          ],
        },
        baristaReadyAt: {
          $cond: [
            {
              $and: [
                "$__updateBarista",
                { $eq: [status, "READY"] },
                { $eq: [{ $ifNull: ["$baristaReadyAt", null] }, null] },
              ],
            },
            now,
            "$baristaReadyAt",
          ],
        },
        updatedAt: now,
      },
    },
    {
      $set: {
        status: overallExpr,
        preparingAt: {
          $cond: [
            {
              $and: [
                { $eq: [status, "PREPARING"] },
                { $eq: [{ $ifNull: ["$preparingAt", null] }, null] },
              ],
            },
            now,
            "$preparingAt",
          ],
        },
      },
    },
    {
      $set: {
        readyAt: {
          $cond: [
            {
              $and: [
                { $eq: ["$status", "READY"] },
                { $eq: [{ $ifNull: ["$readyAt", null] }, null] },
              ],
            },
            now,
            "$readyAt",
          ],
        },
      },
    },
  ];

  if (IS_READY) {
    pipeline.push({ $set: { kitchenStaffId: kAttrExpr, baristaStaffId: bAttrExpr } });
  }
  pipeline.push({ $unset: ["__hasFood", "__hasDrink", "__updateKitchen", "__updateBarista"] });

  const doc = await Order.findOneAndUpdate(filter, pipeline, {
    returnDocument: "after",
    updatePipeline: true,
  });

  if (!doc) {
    // Miss path only: reproduce exact error semantics of the prior read-first flow.
    const existing = await Order.findOne(buildOrderQuery(identifier))
      .select("status items kitchenStatus baristaStatus")
      .lean();
    if (!existing) throw new Error("Order not found");
    if (["SERVED", "PAYMENT_PENDING", "PAID", "CANCELLED", "ARCHIVED"].includes(existing.status)) {
      throw new Error("Order is in a terminal state");
    }
    const hasFood = (existing.items || []).some((i) => i.type === "FOOD" && !i.cancelled);
    const hasDrink = (existing.items || []).some((i) => i.type === "DRINK" && !i.cancelled);
    // Worded with "Cannot" so the existing route mapper classifies this stale-client
    // lifecycle miss as HTTP 400 (never generic 500). No mutation occurs here.
    if (isKitchen && !hasFood) throw new Error("Cannot update order: order has no active FOOD items for Kitchen");
    if (isBarista && !hasDrink) throw new Error("Cannot update order: order has no active DRINK items for Barista");
    // Strict-sequence recheck on fresh state (race: station moved between pre-read
    // and write). Same rules as above; first violation reports precisely.
    const reTouched = [];
    if (isKitchen) reTouched.push("kitchen");
    else if (isBarista) reTouched.push("barista");
    else {
      if (hasFood) reTouched.push("kitchen");
      if (hasDrink) reTouched.push("barista");
    }
    for (const s of reTouched) {
      const cur = (s === "kitchen" ? existing.kitchenStatus : existing.baristaStatus) ?? null;
      const label = s === "kitchen" ? "KITCHEN" : "BARISTA";
      if (status === "READY") {
        if (cur !== "PREPARING") throw new Error(`Invalid READY request for ${label}: station is ${cur ?? "PENDING"}`);
      } else if (cur !== null && cur !== "PENDING") {
        throw new Error(`Invalid ${status} request for ${label}: station is ${cur}`);
      }
    }
    throw new Error("Update failed");
  }

  return { doc };
}

// Waiter acknowledges a READY ticket (kitchen + barista both done).
export async function serveOrder(conn, identifier) {
  const Order = getOrderModel(conn);
  const now = new Date();
  // Atomic SERVE: enforce READY server-side and stamp timestamps in a single
  // write (replaces the prior Order.findOne + findOneAndUpdate = 2 round trips).
  // Idempotent: servedAt/completedAt are only set when currently null.
  const filter = { ...buildOrderQuery(identifier), status: "READY" };
  const pipeline = [
    {
      $set: {
        status: "SERVED",
        updatedAt: now,
        servedAt: {
          $cond: [{ $eq: [{ $ifNull: ["$servedAt", null] }, null] }, now, "$servedAt"],
        },
        completedAt: {
          $cond: [{ $eq: [{ $ifNull: ["$completedAt", null] }, null] }, now, "$completedAt"],
        },
      },
    },
  ];
  const doc = await Order.findOneAndUpdate(filter, pipeline, {
    returnDocument: "after",
    updatePipeline: true,
  });
  if (!doc) {
    // Miss path only: reproduce exact error semantics of the prior read-first flow.
    const existing = await Order.findOne(buildOrderQuery(identifier))
      .select("status")
      .lean();
    if (!existing) throw new Error("Order not found");
    throw new Error("Only READY orders can be served");
  }
  return doc;
}

// Waiter collects payment -> terminal PAID state. Accepts READY or SERVED.
// Idempotent: if order is already PAID, return it (with updated paymentMethod if valid) so
// network retries do not create duplicate financial operations. Totals are always
// trusted from DB (order.totalAmount), never client-provided.
// Transfer requires active payment account; snapshot preserved for historical correctness.
function normalizeTransferMethod(m) {
  const v = String(m || "").trim().toUpperCase();
  if (v === "TELEBIRR") return "TRANSFER"; // legacy brand normalized to generic Transfer
  return v;
}
function isTransferMethod(m) {
  const v = String(m || "").trim().toUpperCase();
  return v === "TRANSFER" || v === "TELEBIRR";
}

export async function payOrder(conn, identifier, { paymentMethod, paymentAccountId, actorId } = {}) {
  const Order = getOrderModel(conn);
  const now = new Date();
  let pm = VALID_PAYMENT_METHODS.includes(paymentMethod) ? paymentMethod : null;
  // Normalize legacy TELEBIRR to canonical TRANSFER for new writes; historical reads keep TELEBIRR
  if (pm === "TELEBIRR") pm = "TRANSFER";
  let paymentAccOid = null;
  let paymentSnapshot = null;
  // Validate transfer account server-side (not trusted client total/account)
  if (pm === "TRANSFER") {
    if (!paymentAccountId || !mongoose.isValidObjectId(String(paymentAccountId))) throw new Error("paymentAccountId is required for Transfer payments");
    paymentAccOid = new mongoose.Types.ObjectId(String(paymentAccountId));
    try {
      const { getPaymentInfoModel } = await import("@/lib/models/PaymentInfo");
      const PaymentInfo = getPaymentInfoModel(conn);
      const acc = await PaymentInfo.findOne({ _id: paymentAccOid }).lean();
      if (!acc) throw new Error("Payment account not found");
      if (acc.isActive === false) throw new Error("Payment account is disabled");
      paymentSnapshot = {
        bankName: String(acc.bankName || "").trim(),
        ownerName: String(acc.ownerName || "").trim(),
        accountNumber: String(acc.accountNumber || "").trim(),
      };
    } catch (e) {
      if (/Payment account (not found|is disabled)/.test(e.message)) throw e;
      throw new Error(e.message || "Failed to validate payment account");
    }
  } else if (pm === "CASH") {
    if (paymentAccountId) throw new Error("paymentAccountId must not be provided for Cash payments");
  } else if (paymentAccountId) {
    throw new Error("paymentAccountId is only allowed for Transfer payments");
  }
  // For already PAID retry, ensure same account (or no account change) to prevent double-pay with different account
  // This check is done after fetching existing order in miss path, but also enforce in pipeline via conditional set

  // Atomic payment: enforce a payable state (SERVED/READY, or already PAID for
  // idempotent retry) and stamp timestamps in a single write (replaces the prior
  // Order.findOne + findOneAndUpdate = 2 round trips). Idempotent: paidAt/
  // completedAt/servedAt are only set when currently null; paymentMethod is set
  // only when a valid method is supplied. Station state is left untouched.
  const filter = {
    ...buildOrderQuery(identifier),
    status: { $in: ["SERVED", "READY", "PAID"] },
  };
  const pipeline = [
    {
      $set: {
        status: "PAID",
        updatedAt: now,
        ...(pm ? { paymentMethod: pm } : {}),
        // Payment account: set only if currently null (first payment), preserve historical snapshot on retry
        ...(paymentAccOid
          ? {
              paymentAccountId: {
                $cond: [{ $eq: [{ $ifNull: ["$paymentAccountId", null] }, null] }, paymentAccOid, "$paymentAccountId"],
              },
              paymentAccountSnapshot: {
                $cond: [
                  { $eq: [{ $ifNull: ["$paymentAccountId", null] }, null] },
                  paymentSnapshot,
                  "$paymentAccountSnapshot",
                ],
              },
            }
          : pm === "CASH"
          ? {
              paymentAccountId: {
                $cond: [{ $eq: [{ $ifNull: ["$paymentAccountId", null] }, null] }, null, "$paymentAccountId"],
              },
              paymentAccountSnapshot: {
                $cond: [{ $eq: [{ $ifNull: ["$paymentAccountId", null] }, null] }, null, "$paymentAccountSnapshot"],
              },
            }
          : {}),
        paidAt: {
          $cond: [{ $eq: [{ $ifNull: ["$paidAt", null] }, null] }, now, "$paidAt"],
        },
        completedAt: {
          $cond: [{ $eq: [{ $ifNull: ["$completedAt", null] }, null] }, now, "$completedAt"],
        },
        servedAt: {
          $cond: [{ $eq: [{ $ifNull: ["$servedAt", null] }, null] }, now, "$servedAt"],
        },
      },
    },
  ];
  const doc = await Order.findOneAndUpdate(filter, pipeline, {
    returnDocument: "after",
    updatePipeline: true,
  });
  if (!doc) {
    // Miss path only: reproduce exact error semantics of the prior read-first flow.
    const existing = await Order.findOne(buildOrderQuery(identifier))
      .select("status")
      .lean();
    if (!existing) throw new Error("Order not found");
    throw new Error("Order must be served before payment");
  }

  // Phase G2: inventory deduction — after successful PAID, idempotent, transactional, never rolls back payment
  // G1 prepareInventoryDeduction is read-only plan; G2 executeInventoryDeduction does $inc + StockMovement in session
  // Phase G4: pass actorId for audit (StockMovement.createdBy), backward compatible when actorId is undefined
  try {
    const { prepareInventoryDeduction, executeInventoryDeduction } = await import("@/lib/inventoryDeductionService");
    const plan = await prepareInventoryDeduction(doc, { connection: conn });
    if (plan.ingredients && plan.ingredients.length > 0) {
      const result = await executeInventoryDeduction(plan, { connection: conn, actorId });
      if (!result.success && !result.skipped) {
        console.warn("[inventory] deduction failed for order", String(doc._id), result.warnings, result.error);
      } else if (result.warnings?.length && !result.skipped) {
        console.warn("[inventory] deduction warnings for order", String(doc._id), result.warnings);
      }
    } else if (plan.warnings?.length) {
      // No ingredients (e.g., recipe missing, external) — log only for observability, not error
      const hasRecipeMissing = plan.warnings.some((w) => /Recipe missing/i.test(w));
      if (!hasRecipeMissing || plan.ingredients.length > 0) {
        console.warn("[inventory] deduction skipped for order", String(doc._id), plan.warnings);
      }
    }
  } catch (deductionErr) {
    console.warn("[inventory] deduction error for order", String(doc._id), deductionErr?.message || deductionErr);
  }

  return doc;
}

// KDS staff dismiss a live ticket from the board. The row stays in the
// database (sales history preserved) but drops out of the ACTIVE query,
// which only covers PENDING / PREPARING / READY.
export async function archiveOrder(conn, identifier) {
  const Order = getOrderModel(conn);
  const order = await Order.findOne(buildOrderQuery(identifier));
  if (!order) throw new Error("Order not found");
  if (order.status === "PAID") {
    throw new Error("Cannot archive a paid order");
  }
  if (order.status === "ARCHIVED" || order.status === "CANCELLED") {
    return order;
  }
  return updateOrderFields(conn, identifier, { status: "ARCHIVED" });
}

// Waiter cancels their OWN whole order, PENDING only. Distinct from station
// CANCEL_ITEM (line-level, KITCHEN/BARISTA) and from manager cancelOrder:
// no items are touched (lines keep their flags), no station/payment/financial
// fields change — only the order-level lifecycle flips PENDING → CANCELLED.
// The atomic filter carries the same lock, so stale/racing requests miss
// cleanly into precise errors (never partial mutation, never generic 500).
export async function cancelOrderByWaiter(conn, identifier, opts = {}) {
  const Order = getOrderModel(conn);
  const now = new Date();
  const role = String(opts.staffRole || opts.role || "").toUpperCase();
  if (role !== "WAITER") throw new Error("Forbidden: CANCEL_ORDER requires WAITER role");
  const actorId = opts.staffId || opts.actorId || null;
  const actorOid =
    actorId && mongoose.isValidObjectId(String(actorId))
      ? new mongoose.Types.ObjectId(String(actorId))
      : null;
  if (!actorOid) throw new Error("Forbidden: waiter session missing staff identity");

  const existing = await Order.findOne(buildOrderQuery(identifier)).select("status waiterId").lean();
  if (!existing) throw new Error("Order not found");
  if (String(existing.waiterId || "") !== String(actorOid)) throw new Error("Forbidden: not your order");
  if (existing.status === "CANCELLED") throw new Error("Order is already cancelled");
  if (existing.status !== "PENDING") throw new Error("Only PENDING orders can be cancelled");

  const docAfter = await Order.findOneAndUpdate(
    { ...buildOrderQuery(identifier), status: "PENDING", waiterId: actorOid },
    { $set: { status: "CANCELLED", updatedAt: now } },
    { returnDocument: "after", runValidators: false }
  );
  if (!docAfter) {
    const re = await Order.findOne(buildOrderQuery(identifier)).select("status waiterId").lean();
    if (!re) throw new Error("Order not found");
    if (String(re.waiterId || "") !== String(actorOid)) throw new Error("Forbidden: not your order");
    if (re.status === "CANCELLED") throw new Error("Order is already cancelled");
    if (re.status !== "PENDING") throw new Error("Only PENDING orders can be cancelled");
    throw new Error("Update failed");
  }
  return docAfter;
}

// Manager voids the whole ticket (terminal).
export async function cancelOrder(conn, identifier) {
  const Order = getOrderModel(conn);
  const order = await Order.findOne(buildOrderQuery(identifier));
  if (!order) throw new Error("Order not found");
  if (order.status === "PAID" || order.status === "CANCELLED") {
    throw new Error("Cannot cancel a paid or already-cancelled order");
  }
  return updateOrderFields(conn, identifier, { status: "CANCELLED" });
}

// Item-level cancellation — station staff cancels own line only.
// Atomic via arrayFilters; overall status/totals derived separately.
// Never cancels whole order unless all active lines become cancelled (handled after update).
export async function cancelOrderItem(conn, identifier, lineId, opts = {}) {
  const Order = getOrderModel(conn);
  const now = new Date();
  const toOid = (id) => id && mongoose.isValidObjectId(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
  if (!lineId || !mongoose.isValidObjectId(String(lineId))) throw new Error("lineId is required and must be valid ObjectId");
  const lineOid = new mongoose.Types.ObjectId(String(lineId));
  const role = String(opts.staffRole || opts.role || "").toUpperCase();
  const isKitchen = role === "KITCHEN";
  const isBarista = role === "BARISTA";
  const isManager = role === "MANAGER";
  if (!isKitchen && !isBarista && !isManager) throw new Error("Forbidden: CANCEL_ITEM requires KITCHEN/BARISTA/MANAGER");
  const actorOid = toOid(opts.staffId || opts.actorId);
  const reasonRaw = typeof opts.reason === "string" ? opts.reason.trim().slice(0, 200) : "";
  const reason = reasonRaw ? reasonRaw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") : null;
  if (reason && (/<script/i.test(reason) || /javascript:/i.test(reason))) throw new Error("Invalid cancel reason");

  // Read to validate station ownership and idempotency before atomic write
  const existing = await Order.findOne(buildOrderQuery(identifier)).select("status items kitchenStatus baristaStatus").lean();
  if (!existing) throw new Error("Order not found");
  if (["SERVED", "PAYMENT_PENDING", "PAID", "CANCELLED", "ARCHIVED"].includes(existing.status)) throw new Error("Cannot cancel line of order in terminal state");
  const target = (existing.items || []).find((it) => {
    if (!it) return false;
    const lid = it.lineId ? String(it.lineId) : null;
    return lid && lid === String(lineOid);
  });
  // Legacy orders without lineId cannot be addressed at line level — no _id
  // fallback exists because subdocuments share no stable per-line _id
  // (schema uses _id:false). Behavior preserved: report not-found.
  if (!target) throw new Error("Order item not found");
  if (target.cancelled) throw new Error("Order item already cancelled");
  if (isKitchen && target.type !== "FOOD") throw new Error("Kitchen can only cancel FOOD items");
  if (isBarista && target.type !== "DRINK") throw new Error("Barista can only cancel DRINK items");
  // Preparation-finished lines cannot be cancelled: overall READY, or the
  // target line's own station already READY. Stale clicks fail cleanly (400).
  if (
    existing.status === "READY" ||
    (target.type === "FOOD" && existing.kitchenStatus === "READY") ||
    (target.type === "DRINK" && existing.baristaStatus === "READY")
  ) {
    throw new Error("Cannot cancel an item that is already finished preparing");
  }
  const station = isKitchen ? "KITCHEN" : isBarista ? "BARISTA" : "MANAGER";

  // Atomic item-level update — touches only matched array element, no whole-order read-modify-write.
  // Line identity, active state and station ownership are evaluated against the SAME
  // array element via $elemMatch. A top-level "items.cancelled": { $ne: true } must
  // NOT be used here: MongoDB evaluates it as "no element equals true", so after one
  // line is cancelled the filter could never match again and every subsequent line
  // cancellation fell through to "Update failed" (HTTP 500).
  const filter = {
    ...buildOrderQuery(identifier),
    status: { $nin: ["SERVED", "PAYMENT_PENDING", "PAID", "CANCELLED", "ARCHIVED"] },
    items: {
      $elemMatch: {
        lineId: lineOid,
        cancelled: { $ne: true },
        ...(isKitchen
          ? { type: "FOOD" }
          : isBarista
            ? { type: "DRINK" }
            : {}),
      },
    },
  };

  const update = {
    $set: {
      "items.$[elem].cancelled": true,
      "items.$[elem].cancelledAt": now,
      "items.$[elem].cancelledBy": actorOid,
      "items.$[elem].cancelledStation": station,
      "items.$[elem].cancelReason": reason,
      updatedAt: now,
    },
  };
  const arrayFilters = [{ "elem.lineId": lineOid, "elem.cancelled": { $ne: true } }];
  if (isKitchen) arrayFilters[0]["elem.type"] = "FOOD";
  if (isBarista) arrayFilters[0]["elem.type"] = "DRINK";

  const docAfter = await Order.findOneAndUpdate(filter, update, { arrayFilters, returnDocument: "after", runValidators: false });
  if (!docAfter) {
    // Re-evaluate for precise error — must mirror pre-read terminal list including PAYMENT_PENDING (race fix)
    const re = await Order.findOne(buildOrderQuery(identifier)).select("status items kitchenStatus baristaStatus").lean();
    if (!re) throw new Error("Order not found");
    if (["SERVED", "PAYMENT_PENDING", "PAID", "CANCELLED", "ARCHIVED"].includes(re.status)) throw new Error("Cannot cancel line of order in terminal state");
    const t2 = (re.items || []).find((it) => it.lineId && String(it.lineId) === String(lineOid));
    if (!t2) throw new Error("Order item not found");
    if (t2.cancelled) throw new Error("Order item already cancelled");
    if (isKitchen && t2.type !== "FOOD") throw new Error("Kitchen can only cancel FOOD items");
    if (isBarista && t2.type !== "DRINK") throw new Error("Barista can only cancel DRINK items");
    if (
      re.status === "READY" ||
      (t2.type === "FOOD" && re.kitchenStatus === "READY") ||
      (t2.type === "DRINK" && re.baristaStatus === "READY")
    ) {
      throw new Error("Cannot cancel an item that is already finished preparing");
    }
    throw new Error("Update failed");
  }

  // Derive station + overall status from remaining ACTIVE lines only, so a
  // cancelled-only station never looks like pending/ready work and overall
  // readiness reflects stations that can still act. Active = not cancelled.
  // Only waiterId/identity, payment and financial fields are untouched here.
  const active = (docAfter.items || []).filter((it) => !it.cancelled);
  const activeHasFood = active.some((it) => it.type === "FOOD");
  const activeHasDrink = active.some((it) => it.type === "DRINK");
  const normKitchen = activeHasFood ? (docAfter.kitchenStatus ?? null) : null;
  const normBarista = activeHasDrink ? (docAfter.baristaStatus ?? null) : null;
  let normStatus = docAfter.status;
  if (active.length === 0) {
    // All lines cancelled → whole order CANCELLED (distinct from ARCHIVED).
    normStatus = "CANCELLED";
  } else if (activeHasFood && activeHasDrink) {
    // Mixed: READY only when both remaining stations are READY, else PREPARING
    // when either has started, else PENDING (mirrors updateOrderStatus).
    const kDone = normKitchen === "READY";
    const bDone = normBarista === "READY";
    const kStarted = kDone || normKitchen === "PREPARING";
    const bStarted = bDone || normBarista === "PREPARING";
    normStatus = kDone && bDone ? "READY" : kStarted || bStarted ? "PREPARING" : "PENDING";
  } else {
    // Single remaining station: its own state determines overall state.
    const only = activeHasFood ? normKitchen : normBarista;
    normStatus = only === "READY" ? "READY" : only === "PREPARING" ? "PREPARING" : "PENDING";
  }
  if (
    normKitchen !== (docAfter.kitchenStatus ?? null) ||
    normBarista !== (docAfter.baristaStatus ?? null) ||
    normStatus !== docAfter.status
  ) {
    // Guarded second write (optimistic concurrency on updatedAt): applies only if
    // no concurrent writer touched the order after our cancellation. A miss means
    // the concurrent writer owns the newer state (its own pipeline derives from
    // active-only data), so skipping is safe. PAID/CANCELLED are never overwritten.
    const normalized = await Order.findOneAndUpdate(
      {
        ...buildOrderQuery(identifier),
        status: { $nin: ["CANCELLED", "PAID"] },
        updatedAt: docAfter.updatedAt,
      },
      { $set: { kitchenStatus: normKitchen, baristaStatus: normBarista, status: normStatus, updatedAt: new Date() } },
      { returnDocument: "after", runValidators: false }
    );
    return normalized || docAfter;
  }
  return docAfter;
}

// Waiter/manager pre-preparation order editing — ORDER-LEVEL lock.
// An order is editable only while its status is PENDING (nothing started).
// Once ANY station starts preparation the whole order is locked; there is no
// per-line editing after that point. The lock is enforced atomically in the
// update filter (status: "PENDING"), so a stale client can never bypass it —
// a concurrent preparation start turns the write into a miss, reported as a
// clean conflict (never a partial mutation: the entire items array + totals
// are written by a single $set).
// Supported ops (validated here, never trusted from client):
//   { op: "setQty", lineId, quantity }  — active line only, integer 1-99
//   { op: "remove", lineId }            — active line only, must keep >= 1 active line
//   { op: "add", menuItemId, quantity } — server snapshots price/name/type from MenuItem
//   { op: "note", lineId, note }        — appends a NOTE component (<=500 chars)
// Cancelled lines can never be edited back to active and are carried over
// untouched. Prices/types for added lines are server-authoritative.
export async function editOrderItems(conn, identifier, changes, opts = {}) {
  const Order = getOrderModel(conn);
  const now = new Date();
  const role = String(opts.staffRole || opts.role || "").toUpperCase();
  const isWaiter = role === "WAITER";
  const isManager = role === "MANAGER";
  if (!isWaiter && !isManager) throw new Error("Forbidden: EDIT_ITEMS requires WAITER/MANAGER");
  const actorId = opts.staffId || opts.actorId || null;
  const actorOid =
    actorId && mongoose.isValidObjectId(String(actorId))
      ? new mongoose.Types.ObjectId(String(actorId))
      : null;
  if (isWaiter && !actorOid) throw new Error("Forbidden: waiter session missing staff identity");
  if (!Array.isArray(changes) || changes.length === 0) throw new Error("changes array is required for EDIT_ITEMS");
  if (changes.length > 20) throw new Error("Too many changes (max 20)");

  const toOid = (id) =>
    id && mongoose.isValidObjectId(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;

  // Authoritative read: ownership + lock are re-checked in the atomic filter below.
  const existing = await Order.findOne(buildOrderQuery(identifier)).lean();
  if (!existing) throw new Error("Order not found");
  if (isWaiter && String(existing.waiterId || "") !== String(actorOid)) throw new Error("Forbidden: not your order");
  if (existing.status !== "PENDING") throw new Error("Only PENDING orders can be edited");

  const working = (existing.items || []).map((it) => ({
    ...it,
    components: Array.isArray(it.components) ? it.components.map((c) => ({ ...c })) : [],
  }));
  const workingByLine = new Map();
  for (const it of working) {
    if (it && it.lineId) workingByLine.set(String(it.lineId), it);
  }
  const badScript = (s) => /<script/i.test(s) || /javascript:/i.test(s) || /on\w+\s*=/i.test(s);

  // Batch-fetch catalog entries for added lines (server-authoritative snapshot).
  const addMenuIds = [];
  for (const ch of changes) {
    if (ch && String(ch.op || "").toLowerCase() === "add" && ch.menuItemId && mongoose.isValidObjectId(String(ch.menuItemId))) {
      addMenuIds.push(String(ch.menuItemId));
    }
  }
  const catalog = new Map();
  if (addMenuIds.length) {
    try {
      const { getMenuItemModel } = await import("@/lib/models/MenuItem");
      const MenuItem = getMenuItemModel(conn);
      const found = await MenuItem.find({ _id: { $in: [...new Set(addMenuIds)] } }).lean();
      for (const m of found || []) catalog.set(String(m._id), m);
    } catch {
      // Catalog unavailable — added lines below report not-found.
    }
  }

  for (let ci = 0; ci < changes.length; ci += 1) {
    const ch = changes[ci] || {};
    const op = String(ch.op || "").toLowerCase();
    if (op === "setqty") {
      const lid = ch.lineId ? String(ch.lineId) : null;
      const target = lid ? workingByLine.get(lid) : null;
      if (!target) throw new Error("Order item not found");
      if (target.cancelled) throw new Error("Cannot edit a cancelled order item");
      const q = Number(ch.quantity ?? ch.qty);
      if (!Number.isInteger(q) || q < 1 || q > 99) throw new Error("quantity must be integer 1-99");
      target.quantity = q;
    } else if (op === "remove") {
      const lid = ch.lineId ? String(ch.lineId) : null;
      const idx = working.findIndex((it) => it && it.lineId && String(it.lineId) === lid);
      if (idx === -1) throw new Error("Order item not found");
      if (working[idx].cancelled) throw new Error("Cannot edit a cancelled order item");
      working.splice(idx, 1);
      if (lid) workingByLine.delete(lid);
    } else if (op === "add") {
      const mid = ch.menuItemId ? String(ch.menuItemId) : null;
      if (!mid || !mongoose.isValidObjectId(mid)) throw new Error("menuItemId must be valid ObjectId");
      const cat = catalog.get(mid);
      if (!cat) throw new Error("Menu item not found");
      if (cat.isAvailable === false || cat.inStock === false) throw new Error("Cannot add unavailable menu item");
      const q = Number(ch.quantity ?? ch.qty ?? 1);
      if (!Number.isInteger(q) || q < 1 || q > 99) throw new Error("quantity must be integer 1-99");
      const snap = resolveCatalogLine(cat, { price: 0, name: "", type: "FOOD" });
      if (!snap.name) throw new Error("Menu item has no usable name");
      working.push({
        lineId: new mongoose.Types.ObjectId(),
        name: snap.name,
        price: snap.price,
        quantity: q,
        type: snap.type,
        isExternal: false,
        itemId: new mongoose.Types.ObjectId(String(cat._id)),
        cancelled: false,
        cancelledAt: null,
        cancelledBy: null,
        cancelledStation: null,
        cancelReason: null,
        components: [],
      });
    } else if (op === "note") {
      const lid = ch.lineId ? String(ch.lineId) : null;
      const target = lid ? workingByLine.get(lid) : null;
      if (!target) throw new Error("Order item not found");
      if (target.cancelled) throw new Error("Cannot edit a cancelled order item");
      const noteRaw = ch.note ?? ch.text ?? ch.instruction ?? "";
      const note = typeof noteRaw === "string" ? noteRaw.trim().slice(0, 500) : "";
      if (!note) throw new Error("note is required for NOTE");
      if (badScript(note)) throw new Error("note contains invalid characters");
      if (!Array.isArray(target.components)) target.components = [];
      if (target.components.length >= 20) throw new Error("too many components (max 20)");
      target.components.push({ kind: "NOTE", note });
    } else {
      throw new Error("Invalid edit operation");
    }
  }

  const remaining = working.filter((it) => it && !it.cancelled);
  if (remaining.length === 0) throw new Error("Order must keep at least one active item");

  // Recompute gross exactly like createOrder (base + priced lineSum).
  const totalAmount =
    Math.round(
      working.reduce((sum, it) => {
        const base = (Number(it.price) || 0) * (Number(it.quantity) || 0);
        const compSum = (it.components || [])
          .filter((c) => c.kind === "PRICED_COMPONENT")
          .reduce((s, c) => s + (Number(c.lineSum) || 0), 0);
        return sum + base + compSum;
      }, 0) * 100
    ) / 100;

  // Atomic write guarded by the SAME lock (plus ownership for waiters): a stale
  // client whose order started preparation concurrently misses cleanly — no
  // partial mutation is possible because items + totals go in one $set.
  const filter = { ...buildOrderQuery(identifier), status: "PENDING" };
  if (isWaiter) filter.waiterId = actorOid;
  const docAfter = await Order.findOneAndUpdate(
    filter,
    { $set: { items: working, totalAmount, updatedAt: now } },
    { returnDocument: "after", runValidators: false }
  );
  if (!docAfter) {
    const re = await Order.findOne(buildOrderQuery(identifier)).select("status waiterId").lean();
    if (!re) throw new Error("Order not found");
    if (isWaiter && String(re.waiterId || "") !== String(actorOid)) throw new Error("Forbidden: not your order");
    if (re.status !== "PENDING") throw new Error("Only PENDING orders can be edited");
    throw new Error("Update failed");
  }
  return docAfter;
}

// Waiter submits payment for cashier verification — does NOT mark PAID.
// Persists method + account snapshot, sets PAYMENT_PENDING, not paidAt, not revenue, no inventory.
export async function submitPaymentForVerification(conn, identifier, { paymentMethod, paymentAccountId, actorId } = {}) {
  const Order = getOrderModel(conn);
  const now = new Date();
  let pm = VALID_PAYMENT_METHODS.includes(paymentMethod) ? paymentMethod : null;
  if (pm === "TELEBIRR") pm = "TRANSFER"; // normalize legacy brand
  if (!pm || pm === "NONE") throw new Error("paymentMethod is required");
  let paymentAccOid = null;
  let paymentSnapshot = null;
  if (pm === "TRANSFER") {
    if (!paymentAccountId || !mongoose.isValidObjectId(String(paymentAccountId))) throw new Error("paymentAccountId is required for Transfer payments");
    paymentAccOid = new mongoose.Types.ObjectId(String(paymentAccountId));
    try {
      const { getPaymentInfoModel } = await import("@/lib/models/PaymentInfo");
      const PaymentInfo = getPaymentInfoModel(conn);
      const acc = await PaymentInfo.findOne({ _id: paymentAccOid }).lean();
      if (!acc) throw new Error("Payment account not found");
      if (acc.isActive === false) throw new Error("Payment account is disabled");
      paymentSnapshot = {
        bankName: String(acc.bankName || "").trim(),
        ownerName: String(acc.ownerName || "").trim(),
        accountNumber: String(acc.accountNumber || "").trim(),
      };
    } catch (e) {
      if (/Payment account (not found|is disabled)/.test(e.message)) throw e;
      throw new Error(e.message || "Failed to validate payment account");
    }
  } else if (pm === "CASH") {
    if (paymentAccountId) throw new Error("paymentAccountId must not be provided for Cash payments");
  }
  const actorOid = actorId && mongoose.isValidObjectId(String(actorId)) ? new mongoose.Types.ObjectId(String(actorId)) : null;
  // Canonical path only: SERVED → PAYMENT_PENDING. READY must go through WAITER
  // SERVE first; no silent READY-payment bypass (historical PAID data untouched).
  const filter = {
    ...buildOrderQuery(identifier),
    status: "SERVED",
  };
  const update = {
    $set: {
      status: "PAYMENT_PENDING",
      paymentMethod: pm,
      ...(paymentAccOid ? { paymentAccountId: paymentAccOid, paymentAccountSnapshot: paymentSnapshot } : { paymentAccountId: null, paymentAccountSnapshot: null }),
      paymentSubmittedAt: now,
      paymentSubmittedBy: actorOid,
      // Clear previous verification, preserve prior rejection for audit (new attempt)
      paymentVerifiedAt: null,
      paymentVerifiedBy: null,
      updatedAt: now,
    },
  };
  const doc = await Order.findOneAndUpdate(filter, update, { returnDocument: "after", runValidators: false });
  if (!doc) {
    const existing = await Order.findOne(buildOrderQuery(identifier)).select("status").lean();
    if (!existing) throw new Error("Order not found");
    if (existing.status === "PAYMENT_PENDING") throw new Error("Payment already submitted for verification");
    if (existing.status === "PAID") throw new Error("Order already paid");
    if (existing.status !== "SERVED") throw new Error("Order must be served before payment submission");
    throw new Error("Update failed");
  }
  return doc;
}

// Cashier confirms pending payment to PAID — atomically, preserves snapshot, sets paidAt, prevents double-confirm
export async function confirmPayment(conn, identifier, { actorId } = {}) {
  const Order = getOrderModel(conn);
  const now = new Date();
  const actorOid = actorId && mongoose.isValidObjectId(String(actorId)) ? new mongoose.Types.ObjectId(String(actorId)) : null;
  const filter = {
    ...buildOrderQuery(identifier),
    status: "PAYMENT_PENDING",
  };
  const pipeline = [
    {
      $set: {
        status: "PAID",
        updatedAt: now,
        paidAt: {
          $cond: [{ $eq: [{ $ifNull: ["$paidAt", null] }, null] }, now, "$paidAt"],
        },
        completedAt: {
          $cond: [{ $eq: [{ $ifNull: ["$completedAt", null] }, null] }, now, "$completedAt"],
        },
        servedAt: {
          $cond: [{ $eq: [{ $ifNull: ["$servedAt", null] }, null] }, now, "$servedAt"],
        },
        paymentVerifiedAt: now,
        paymentVerifiedBy: actorOid,
        paymentRejectedAt: null,
        paymentRejectedBy: null,
        paymentRejectionReason: null,
      },
    },
  ];
  const doc = await Order.findOneAndUpdate(filter, pipeline, { returnDocument: "after", updatePipeline: true });
  if (!doc) {
    const existing = await Order.findOne(buildOrderQuery(identifier)).select("status").lean();
    if (!existing) throw new Error("Order not found");
    if (existing.status === "PAID") throw new Error("Order already paid");
    if (existing.status !== "PAYMENT_PENDING") throw new Error("Payment not pending verification");
    throw new Error("Update failed");
  }
  // Inventory deduction only on cashier-confirmed PAID, idempotent
  try {
    const { prepareInventoryDeduction, executeInventoryDeduction } = await import("@/lib/inventoryDeductionService");
    const plan = await prepareInventoryDeduction(doc, { connection: conn });
    if (plan.ingredients && plan.ingredients.length > 0) {
      const result = await executeInventoryDeduction(plan, { connection: conn, actorId });
      if (!result.success && !result.skipped) console.warn("[inventory] deduction failed for order", String(doc._id), result.warnings, result.error);
      else if (result.warnings?.length && !result.skipped) console.warn("[inventory] deduction warnings for order", String(doc._id), result.warnings);
    } else if (plan.warnings?.length) {
      const hasRecipeMissing = plan.warnings.some((w) => /Recipe missing/i.test(w));
      if (!hasRecipeMissing || plan.ingredients.length > 0) console.warn("[inventory] deduction skipped for order", String(doc._id), plan.warnings);
    }
  } catch (deductionErr) {
    console.warn("[inventory] deduction error for order", String(doc._id), deductionErr?.message || deductionErr);
  }
  return doc;
}

// Cashier rejects pending payment — back to SERVED, preserves submitted snapshot for audit, records rejection
export async function rejectPayment(conn, identifier, { reason, actorId } = {}) {
  const Order = getOrderModel(conn);
  const now = new Date();
  const actorOid = actorId && mongoose.isValidObjectId(String(actorId)) ? new mongoose.Types.ObjectId(String(actorId)) : null;
  const reasonStr = typeof reason === "string" ? reason.trim().slice(0, 500).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") : null;
  if (reasonStr && (/<script/i.test(reasonStr) || /javascript:/i.test(reasonStr))) throw new Error("Invalid rejection reason");
  const filter = {
    ...buildOrderQuery(identifier),
    status: "PAYMENT_PENDING",
  };
  const update = {
    $set: {
      status: "SERVED",
      paymentRejectedAt: now,
      paymentRejectedBy: actorOid,
      paymentRejectionReason: reasonStr || null,
      // Keep paymentMethod/account snapshot for audit, but clear verified fields
      paymentVerifiedAt: null,
      paymentVerifiedBy: null,
      updatedAt: now,
    },
  };
  const doc = await Order.findOneAndUpdate(filter, update, { returnDocument: "after", runValidators: false });
  if (!doc) {
    const existing = await Order.findOne(buildOrderQuery(identifier)).select("status").lean();
    if (!existing) throw new Error("Order not found");
    if (existing.status !== "PAYMENT_PENDING") throw new Error("Payment not pending verification");
    throw new Error("Update failed");
  }
  return doc;
}

// Update payment fields independently of status.
export async function updatePayment(conn, identifier, { paymentMethod }) {
  const fields = VALID_PAYMENT_METHODS.includes(paymentMethod)
    ? { paymentMethod }
    : {};
  const order = await updateOrderFields(conn, identifier, fields);
  if (!order) throw new Error("Order not found");
  // If this settles an already-PAID order, stamp completion timestamps too.
  if (order.status === "PAID") {
    const extra = {};
    if (!order.paidAt) extra.paidAt = new Date();
    if (!order.completedAt) extra.completedAt = new Date();
    if (!order.servedAt) extra.servedAt = new Date();
    if (Object.keys(extra).length) {
      await updateOrderFields(conn, identifier, extra);
    }
  }
  return order;
}

// Shape consumed by the Waiter UI, KDS and Manager Dashboard. Item names are
// always flattened to plain strings (legacy orders may store LocalizedString
// objects) so client JSX can render them safely.
// Includes auditable staff FKs and lifecycle timestamps for manager reporting.
// Includes per-station statuses for mixed-order independent READY handling.
export function toKdsShape(order) {
  const items = (order.items || []).map((i) => {
    const comps = Array.isArray(i.components) ? i.components : [];
    const mappedComps = comps.map((c) => ({
      componentId: c.componentId ? String(c.componentId) : null,
      kind: c.kind || null,
      note: c.note || null,
      name: c.name || null,
      quantity: c.quantity ?? null,
      unitPrice: c.unitPrice ?? null,
      lineSum: c.lineSum ?? (c.quantity != null && c.unitPrice != null ? Math.round(Number(c.quantity) * Number(c.unitPrice) * 100) / 100 : null),
      inventoryItemId: c.inventoryItemId ? String(c.inventoryItemId) : null,
      stockQuantity: c.stockQuantity ?? null,
      stockUnit: c.stockUnit || null,
      costSnapshot: c.costSnapshot ?? null,
      totalCost: c.totalCost ?? null,
    }));
    const baseSub = Math.round((i.price || 0) * (i.quantity || 0) * 100) / 100;
    const compsSum = mappedComps
      .filter((c) => c.kind === "PRICED_COMPONENT")
      .reduce((s, c) => s + (Number(c.lineSum) || 0), 0);
    return {
      lineId: i.lineId ? String(i.lineId) : null,
      name: getLocalizedSingleString(i.name),
      price: i.price,
      quantity: i.quantity,
      type: i.type,
      isExternal: !!i.isExternal,
      itemId: i.itemId ? String(i.itemId) : null,
      subTotal: baseSub,
      components: mappedComps,
      // Sum of priced components for this item (informational, not stored separately)
      componentsTotal: Math.round(compsSum * 100) / 100,
      itemTotal: Math.round((baseSub + compsSum) * 100) / 100,
      cancelled: !!i.cancelled,
      cancelledAt: i.cancelledAt ? new Date(i.cancelledAt).toISOString() : null,
      cancelledBy: i.cancelledBy ? String(i.cancelledBy) : null,
      cancelledStation: i.cancelledStation || null,
      cancelReason: i.cancelReason || null,
    };
  });

  // Derived amounts: preserve immutable gross totalAmount; compute net for payable and cancelled slice for reports/audit.
  // Gross includes base + priced components. Notes have 0 revenue.
  const gross = Number(order.totalAmount) || 0;
  const netAmount = Math.round(
    items
      .filter((it) => !it.cancelled)
      .reduce((s, it) => {
        const base = (Number(it.price) || 0) * (Number(it.quantity) || 0);
        const comps = (it.components || []).filter((c) => c.kind === "PRICED_COMPONENT").reduce((cs, c) => cs + (Number(c.lineSum) || 0), 0);
        return s + base + comps;
      }, 0) * 100
  ) / 100;
  const cancelledAmount = Math.round((gross - netAmount) * 100) / 100;

  return {
    _id: order._id.toString(),
    orderNumber: order.orderNumber,
    tableNumber: order.tableNumber,
    waiterName: order.waiterName,
    waiterId: order.waiterId ? String(order.waiterId) : null,
    waiterNumber: order.waiterNumber ?? null,
    waiterInfo: order.waiterInfo
      ? {
          waiterId: order.waiterInfo.waiterId ?? null,
          waiterNumber: order.waiterInfo.waiterNumber ?? null,
          shiftId: order.waiterInfo.shiftId ?? null,
          deviceId: order.waiterInfo.deviceId ?? null,
        }
      : null,
    kitchenStaffId: order.kitchenStaffId ? String(order.kitchenStaffId) : null,
    baristaStaffId: order.baristaStaffId ? String(order.baristaStaffId) : null,
    status: order.status,
    kitchenStatus: order.kitchenStatus || null,
    baristaStatus: order.baristaStatus || null,
    isExternal: !!order.isExternal,
    items,
    totalAmount: order.totalAmount,
    netAmount,
    cancelledAmount,
    paymentMethod: order.paymentMethod || "NONE",
    paymentAccountId: order.paymentAccountId ? String(order.paymentAccountId) : null,
    paymentAccountSnapshot: order.paymentAccountSnapshot
      ? {
          bankName: order.paymentAccountSnapshot.bankName || null,
          ownerName: order.paymentAccountSnapshot.ownerName || null,
          accountNumber: order.paymentAccountSnapshot.accountNumber || null,
        }
      : null,
    createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : null,
    updatedAt: order.updatedAt ? new Date(order.updatedAt).toISOString() : null,
    preparingAt: order.preparingAt ? new Date(order.preparingAt).toISOString() : null,
    readyAt: order.readyAt ? new Date(order.readyAt).toISOString() : null,
    servedAt: order.servedAt ? new Date(order.servedAt).toISOString() : null,
    paidAt: order.paidAt ? new Date(order.paidAt).toISOString() : null,
    completedAt: order.completedAt ? new Date(order.completedAt).toISOString() : null,
    kitchenPreparingAt: order.kitchenPreparingAt ? new Date(order.kitchenPreparingAt).toISOString() : null,
    kitchenReadyAt: order.kitchenReadyAt ? new Date(order.kitchenReadyAt).toISOString() : null,
    baristaPreparingAt: order.baristaPreparingAt ? new Date(order.baristaPreparingAt).toISOString() : null,
    baristaReadyAt: order.baristaReadyAt ? new Date(order.baristaReadyAt).toISOString() : null,
    paymentSubmittedAt: order.paymentSubmittedAt ? new Date(order.paymentSubmittedAt).toISOString() : null,
    paymentSubmittedBy: order.paymentSubmittedBy ? String(order.paymentSubmittedBy) : null,
    paymentVerifiedAt: order.paymentVerifiedAt ? new Date(order.paymentVerifiedAt).toISOString() : null,
    paymentVerifiedBy: order.paymentVerifiedBy ? String(order.paymentVerifiedBy) : null,
    paymentRejectedAt: order.paymentRejectedAt ? new Date(order.paymentRejectedAt).toISOString() : null,
    paymentRejectedBy: order.paymentRejectedBy ? String(order.paymentRejectedBy) : null,
    paymentRejectionReason: order.paymentRejectionReason || null,
  };
}
