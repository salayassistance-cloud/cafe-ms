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

  return {
    name,
    price: Math.round(price * 100) / 100,
    quantity,
    type,
    itemId,
    isExternal,
  };
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
    const price =
      cat && Number.isFinite(Number(cat.price))
        ? Math.round(Number(cat.price) * 100) / 100
        : it.price;
    // Catalog names are LocalizedString objects — flatten to a plain string so
    // React never receives an object as a JSX child.
    const name = getLocalizedSingleString(cat?.name) || it.name;
    // Canonical routing: FOOD = KITCHEN, DRINK = BARISTA. Resolve from MenuItem.
    // Priority: cat.categoryType > cat.targetStation/station > client type
    let type = it.type;
    if (cat) {
      if (cat.categoryType && ITEM_TYPE.includes(cat.categoryType)) type = cat.categoryType;
      else if (cat.targetStation === "BARISTA" || cat.station === "BARISTA") type = "DRINK";
      else if (cat.targetStation === "KITCHEN" || cat.station === "KITCHEN") type = "FOOD";
    }
    const itemId = cat ? new mongoose.Types.ObjectId(String(cat._id)) : (it.itemId ? new mongoose.Types.ObjectId(String(it.itemId)) : null);
    return { name, price, quantity: it.quantity, type, isExternal: !!it.isExternal, ...(itemId ? { itemId } : {}) };
  });

  const totalAmount =
    Math.round(
      items.reduce((sum, it) => sum + it.price * it.quantity, 0) * 100
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

  // --- Single atomic update (was Order.findOne + findOneAndUpdate = 2 round trips) ---
  // All derived fields are computed inside the DB with an aggregation pipeline,
  // so the prep-status PATCH performs exactly one order write. Error semantics
  // and per-station / terminal-state behavior are preserved exactly.
  const filter = {
    ...buildOrderQuery(identifier),
    status: { $nin: ["SERVED", "PAID", "CANCELLED", "ARCHIVED"] },
  };
  if (isKitchen) filter["items.type"] = "FOOD";
  if (isBarista) filter["items.type"] = "DRINK";

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
        in: { $eq: ["$$it.type", "FOOD"] },
      },
    },
  };
  const hasDrinkExpr = {
    $anyElementTrue: {
      $map: {
        input: { $ifNull: ["$items", []] },
        as: "it",
        in: { $eq: ["$$it.type", "DRINK"] },
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
      .select("status items")
      .lean();
    if (!existing) throw new Error("Order not found");
    if (["SERVED", "PAID", "CANCELLED", "ARCHIVED"].includes(existing.status)) {
      throw new Error("Order is in a terminal state");
    }
    const hasFood = (existing.items || []).some((i) => i.type === "FOOD");
    const hasDrink = (existing.items || []).some((i) => i.type === "DRINK");
    if (isKitchen && !hasFood) throw new Error("Order has no FOOD items for Kitchen");
    if (isBarista && !hasDrink) throw new Error("Order has no DRINK items for Barista");
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
export async function payOrder(conn, identifier, { paymentMethod } = {}) {
  const Order = getOrderModel(conn);
  const now = new Date();
  const pm = VALID_PAYMENT_METHODS.includes(paymentMethod) ? paymentMethod : null;
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
  const items = (order.items || []).map((i) => ({
    name: getLocalizedSingleString(i.name),
    price: i.price,
    quantity: i.quantity,
    type: i.type,
    isExternal: !!i.isExternal,
    itemId: i.itemId ? String(i.itemId) : null,
    subTotal: Math.round((i.price || 0) * (i.quantity || 0) * 100) / 100,
  }));

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
    paymentMethod: order.paymentMethod || "NONE",
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
  };
}
