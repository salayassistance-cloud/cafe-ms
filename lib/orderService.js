import mongoose from "mongoose";
import { getOrderModel, ITEM_TYPE } from "@/lib/models/Order";
import {
  VALID_PAYMENT_METHODS,
  TERMINAL_ORDER_STATUSES,
  isTerminalOrderStatus,
} from "@/lib/constants";
import {
  bumpMenuItemPolicyVersions,
  normalizePolicyVersion,
  ORDER_EDIT_CONFLICT,
  POLICY_VERSION_CONFLICT,
  PolicyVersionError,
  runPolicyVersionTransactionOnce,
} from "@/lib/inventoryPolicyVersionService";
import {
  isTransientTransactionError,
  isUnknownCommitResult,
} from "@/lib/transactionRunner";
import { getLocalizedSingleString } from "@/lib/displayName";
import {
  resolveInventoryPolicy,
  validateOrderLineInventoryPolicy,
  isTrackedRecipeUsable,
} from "@/lib/inventoryPolicy";
import {
  ensureOrderInventoryReservation,
  assertOrderInventoryReady,
  assertOrderInventoryPayable,
  consumeOrderInventory,
  releaseOrderInventory,
  reconcileOrderInventory,
  recordPostPreparationVoid,
  isOrderInventoryConsumed,
  InventoryReservationError,
} from "@/lib/inventoryReservationService";
import {
  resolveExtraComponents,
  assertExtraStockReserved,
  hasExtraComponents,
  ExtraItemError,
} from "@/lib/extraItemService";
import { logEvent } from "@/lib/operationalLogger";

// Only version conflicts and genuine transient transaction errors justify
// rebuilding the whole order attempt; permanent validation errors propagate.
function isRebuildableRetryError(err) {
  return (
    err?.code === POLICY_VERSION_CONFLICT ||
    (isTransientTransactionError(err) && !isUnknownCommitResult(err))
  );
}

// H1: batch-load Recipes for TRACKED menu ids. Shared by createOrder and
// editOrderItems so the TRACKED gate has exactly one implementation. A read
// failure is a controlled 503, never an empty result. Duplicate Recipe
// documents for one MenuItem are ambiguous and fail closed by omitting the
// entry (the gate then reports TRACKED_RECIPE_INVALID).
async function loadTrackedRecipeMap(conn, trackedIds) {
  const recipeByMenuId = new Map();
  if (!trackedIds.length) return recipeByMenuId;
  try {
    const { getRecipeModel } = await import("@/lib/models/Recipe");
    const Recipe = getRecipeModel(conn);
    const recipeRows = await Recipe.find({
      menuItemId: { $in: trackedIds },
    }).lean();
    const recipeCounts = new Map();
    for (const row of recipeRows) {
      const key = String(row.menuItemId);
      recipeCounts.set(key, (recipeCounts.get(key) || 0) + 1);
      recipeByMenuId.set(key, row);
    }
    // Duplicate Recipe documents for one MenuItem are ambiguous. Fail closed
    // by treating the item as having no usable Recipe.
    for (const [key, count] of recipeCounts) {
      if (count > 1) recipeByMenuId.delete(key);
    }
  } catch (err) {
    logEvent("error", "order_recipe_read_failed", {
      errorName: err?.name,
      errorMessage: err?.message || String(err),
      errorCode: err?.code,
    });
    throw new OrderCatalogError(
      "Menu catalog is temporarily unavailable. Please retry shortly.",
      503,
      "CATALOG_UNAVAILABLE"
    );
  }
  return recipeByMenuId;
}

// H1.3: turn a validated live Recipe into the immutable snapshot entry stored
// on the Order. Returns null unless the Recipe is usable under the same rule
// the create gate uses, so a malformed capture can never be persisted.
function buildRecipeSnapshotEntry(menuItemId, recipe) {
  if (!isTrackedRecipeUsable(recipe)) return null;
  const menuOid = mongoose.isValidObjectId(String(menuItemId))
    ? new mongoose.Types.ObjectId(String(menuItemId))
    : null;
  if (!menuOid) return null;
  const ingredients = [];
  for (const ing of recipe.ingredients) {
    const inventoryItemId = String(ing.inventoryItemId || "").trim();
    if (!mongoose.isValidObjectId(inventoryItemId)) return null;
    ingredients.push({
      inventoryItemId: new mongoose.Types.ObjectId(inventoryItemId),
      quantity: Number(ing.quantity),
      unit: String(ing.unit).trim(),
    });
  }
  if (ingredients.length === 0) return null;
  const recipeId =
    recipe._id && mongoose.isValidObjectId(String(recipe._id))
      ? new mongoose.Types.ObjectId(String(recipe._id))
      : null;
  return { menuItemId: menuOid, recipeId, ingredients };
}

// Snapshot for a brand-new order: every TRACKED line captured from the same
// active Recipe batch the create gate validated.
function buildInventoryRecipeSnapshot(recipeByMenuId) {
  const recipes = [];
  for (const [menuItemId, recipe] of recipeByMenuId.entries()) {
    const entry = buildRecipeSnapshotEntry(menuItemId, recipe);
    if (entry) recipes.push(entry);
  }
  if (recipes.length === 0) return null;
  return { capturedAt: new Date(), recipes };
}

// Merge capture for TRACKED lines added while an order is still PENDING.
// Existing entries are never rewritten (the order's capture is immutable) and
// unrelated edits return null so the field is left untouched.
function extendInventoryRecipeSnapshot(existingSnapshot, recipeByMenuId) {
  const recipes = [];
  const seen = new Set();
  for (const entry of Array.isArray(existingSnapshot?.recipes) ? existingSnapshot.recipes : []) {
    const menuItemId = String(entry?.menuItemId || "");
    if (!menuItemId) continue;
    recipes.push({
      menuItemId: entry.menuItemId,
      recipeId: entry.recipeId ?? null,
      ingredients: (Array.isArray(entry.ingredients) ? entry.ingredients : []).map((ing) => ({
        inventoryItemId: ing.inventoryItemId,
        quantity: ing.quantity,
        unit: ing.unit,
      })),
    });
    seen.add(menuItemId);
  }
  let added = false;
  for (const [menuItemId, recipe] of recipeByMenuId.entries()) {
    if (seen.has(String(menuItemId))) continue;
    const entry = buildRecipeSnapshotEntry(menuItemId, recipe);
    if (!entry) continue;
    recipes.push(entry);
    seen.add(String(menuItemId));
    added = true;
  }
  if (!added) return null;
  return {
    capturedAt: existingSnapshot?.capturedAt || new Date(),
    recipes,
  };
}

// Typed catalog failures raised BEFORE any order write. The POST /api/orders
// route maps the numeric status/code to the HTTP envelope (same convention as
// the other order routes), so a catalog read failure is a controlled 503 and an
// unavailable item is a controlled 4xx — never a generic 500 or a client-value
// fallback.
export class OrderCatalogError extends Error {
  constructor(message, status = 400, code = "ORDER_CATALOG_INVALID") {
    super(message);
    this.name = "OrderCatalogError";
    this.status = status;
    this.code = code;
  }
}

// Shared business logic for the unified order pipeline: creation (with price
// snapshotting from the MenuItem catalog), status updates (whole-ticket prep
// phase), and the KDS projection used by the real-time stream.
// Auditable: every order is locked to waiterId/waiterName and records
// kitchenStaffId/baristaStaffId/hotDrinkStaffId on READY for manager reporting.

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
async function genOrderNumber(conn, session = null) {
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
        session,
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
// Extra Items ({ itemId, quantity, isExtraItem: true }) are ID-only: any client
// name/price/type/unit/components are ignored and resolved from the catalog.
function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;

  // Standalone Extra Item lines are legacy-only. Extras must be attached to a
  // parent menu item as PRICED_COMPONENT children.
  if (raw.isExtraItem === true) return null;

  const quantity = Number(raw.quantity ?? raw.qty);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return null;

  let itemId = null;
  if (raw.itemId && mongoose.isValidObjectId(String(raw.itemId))) itemId = String(raw.itemId);
  else if (raw._id && mongoose.isValidObjectId(String(raw._id))) itemId = String(raw._id);

  const name = getLocalizedSingleString(raw.name).trim() || getLocalizedSingleString(raw.title).trim();
  if (!name) return null;

  const price = Number(raw.price);
  if (!Number.isFinite(price) || price < 0) return null;

  // Client type is a hint only — server will resolve canonical type from MenuItem when itemId present.
  const type = ITEM_TYPE.includes(raw.type)
    ? raw.type
    : raw.hotDrink === true || String(raw.category).toUpperCase() === "HOT_DRINK"
    ? "HOT_DRINK"
    : raw.barista === true || String(raw.category).toUpperCase() === "DRINK"
    ? "DRINK"
    : "FOOD";

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
    // isExternal is a historical read-only marker. Client input is ignored.
    isExternal: false,
    isExtraItem: false,
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

  // PRICED_COMPONENT — Extra Item identity only. The parent order line is the
  // only place a client may attach extras; free-text name/price/stock are gone.
  const extraRaw = raw.extraItemId ?? raw.extraId;
  const extraItemId = extraRaw && mongoose.isValidObjectId(String(extraRaw))
    ? new mongoose.Types.ObjectId(String(extraRaw))
    : null;
  if (!extraItemId) return null;
  const qtyRaw = raw.quantity ?? raw.qty;
  const quantity = Number(qtyRaw);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return null;

  return {
    componentId: new mongoose.Types.ObjectId(),
    kind: "PRICED_COMPONENT",
    note: null,
    // All money/unit/stock fields are resolved from the Extra Item + linked
    // InventoryItem server-side after normalization.
    name: null,
    quantity,
    unitPrice: null,
    lineSum: null,
    extraItemId,
    inventoryItemId: null,
    stockQuantity: null,
    stockUnit: null,
    costSnapshot: null,
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
    else if (cat.targetStation === "HOT_DRINK" || cat.station === "HOT_DRINK") type = "HOT_DRINK";
    else if (cat.targetStation === "BARISTA" || cat.station === "BARISTA") type = "DRINK";
    else if (cat.targetStation === "KITCHEN" || cat.station === "KITCHEN") type = "FOOD";
  }
  return { price, name, type };
}

// Canonical effective availability for an orderable MenuItem. Missing optional
// flags are NOT treated as unavailable; only an explicit false blocks ordering.
// Shared by createOrder and editOrderItems so both paths stay identical.
export function isMenuItemUnavailable(cat) {
  return !!cat && (cat.isAvailable === false || cat.inStock === false);
}

// Inventory hooks are additive to the order lifecycle. A hook failure must
// never roll back a committed order/payment/cancellation; the preparation gate
// re-creates or self-heals the reservation on the next attempt.
async function runInventoryHook(label, order, fn) {
  try {
    return await fn();
  } catch (err) {
    // Phase 2.2: the hook remains non-fatal by design (the order/payment is
    // already committed), but the failure is now a structured, redacted,
    // alertable event instead of an unstructured warning. Do not convert this
    // to a throw: that would report failure for an operation that succeeded.
    logEvent("error", "inventory_hook_failed", {
      hook: label,
      orderId: String(order?._id || order || ""),
      errorName: err?.name,
      errorMessage: err?.message || String(err),
      errorCode: err?.code,
    });
    return null;
  }
}

// Create an order. Every ordinary line must reference a real MenuItem: prices,
// names and station routing are snapshotted from the catalog and the client's
// values are never used for a catalog-backed line (C1). A missing or unresolved
// catalog reference rejects the whole order before any write.
// Auditable: caller SHOULD pass waiterId/waiterName from the authenticated
// session (see /api/orders POST). If waiterId is a valid ObjectId it is stored
// as FK to Staff; otherwise stored as null for legacy orders.
// Phase 2.1: a conditional policyVersion write can miss when a Manager
// reclassifies concurrently. The whole attempt is then retried so catalog
// resolution, policy validation and snapshots are rebuilt from fresh data.
export async function createOrder(conn, payload) {
  let lastConflict = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await createOrderAttempt(conn, payload);
    } catch (err) {
      if (isRebuildableRetryError(err) && attempt < 2) {
        lastConflict = err;
        continue;
      }
      throw err;
    }
  }
  throw lastConflict;
}

async function createOrderAttempt(conn, payload) {
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

  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  if (rawItems.length === 0) {
    throw new Error("Order must contain at least one item");
  }

  // C1: never drop an invalid line and persist the survivors — that would
  // create a partial order. A malformed line rejects the whole order before any
  // write, exactly like a missing/unresolved catalog identity below.
  const normalizedItems = rawItems.map(normalizeItem);
  if (normalizedItems.some((it) => !it)) {
    throw new Error(
      "Order contains an invalid item line: a catalog itemId, name, price and quantity 1-99 are required for every order line"
    );
  }
  let items = normalizedItems;

  // C1: a line without a catalog identity has no recipe/stock context and would
  // be persisted as a NO_INVENTORY line that can be prepared and paid with no
  // deduction. validateCreateOrderPayload rejects this at the HTTP boundary;
  // this guard protects direct service callers too.
  if (items.some((it) => !it.itemId)) {
    throw new Error(
      "Order line has no catalog identity: a valid menu itemId is required for every order line"
    );
  }

  // Batch-fetch the catalog entries referenced by itemId. Routing is
  // SERVER-AUTHORITATIVE: canonical price/name/type come from the MenuItem doc
  // (categoryType/station/targetStation), never from the client payload.
  // C1/M1: a catalog read failure throws a controlled 503 instead of falling
  // back to client values, and any id that does not resolve rejects the whole
  // order before it is written.
  const requestedIds = items.map((i) => String(i.itemId));
  const uniqueIds = [...new Set(requestedIds)];
  const snapshot = new Map();
  try {
    const { getMenuItemModel } = await import("@/lib/models/MenuItem");
    const MenuItem = getMenuItemModel(conn);
    const found = await MenuItem.find({
      _id: { $in: uniqueIds },
      isDeleted: { $ne: true },
    }).lean();
    for (const m of found) snapshot.set(String(m._id), m);
  } catch (err) {
    // M1: a failed catalog read must fail closed. Never fall back to client
    // name/price/type, never continue with an empty snapshot, and never write an
    // order or inventory hold. Raw driver details stay in the internal log.
    logEvent("error", "order_catalog_read_failed", {
      errorName: err?.name,
      errorMessage: err?.message || String(err),
      errorCode: err?.code,
    });
    throw new OrderCatalogError(
      "Menu catalog is temporarily unavailable. Please retry shortly.",
      503,
      "CATALOG_UNAVAILABLE"
    );
  }

  // A successful query with no matching document is a distinct identity error,
  // not a catalog outage (M1). It remains a controlled 4xx.
  const missingIds = uniqueIds.filter((id) => !snapshot.has(id));
  if (missingIds.length > 0) {
    throw new OrderCatalogError(
      `Menu item ${missingIds[0]} was not found in the catalog: a valid catalog itemId is required for every order line`,
      400,
      "CATALOG_ITEM_NOT_FOUND"
    );
  }

  // Phase 2.1: remember the exact version observed with the policy snapshot.
  // The conditional write below uses this value; a concurrent classification
  // changes the version and forces a full re-resolution retry.
  const policyVersions = new Map(
    uniqueIds.map((id) => [id, normalizePolicyVersion(snapshot.get(id)?.policyVersion)])
  );

  // H1: explicit inventory policy gate for NEW orders only. Legacy UNKNOWN
  // items are never silently classified; historical EXTERNAL is not sellable;
  // TRACKED requires a usable Recipe. Existing open orders are deliberately not
  // re-evaluated here — they finish under the legacy compatibility rules.
  const trackedIds = uniqueIds.filter(
    (id) => resolveInventoryPolicy(snapshot.get(id)) === "TRACKED"
  );
  const recipeByMenuId = await loadTrackedRecipeMap(conn, trackedIds);
  // H1.4: the policy validated here is exactly the value frozen onto each new
  // order line below. It comes from the catalog document, never from the client.
  const policyByMenuId = new Map();
  for (const id of uniqueIds) {
    const check = validateOrderLineInventoryPolicy({
      inventoryPolicy: resolveInventoryPolicy(snapshot.get(id)),
      recipe: recipeByMenuId.get(id) || null,
    });
    if (!check.ok) {
      throw new OrderCatalogError(check.error, 409, check.code);
    }
    policyByMenuId.set(id, check.policy);
  }

  // H1.3: freeze the active Recipe for every TRACKED line on this order. The
  // capture is written with the Order document, so reservation and deduction
  // keep using these exact rows even if the live Recipe is later edited,
  // deactivated or deleted. Orders with no TRACKED line stay null (legacy
  // behavior, no extra document weight).
  const inventoryRecipeSnapshot = buildInventoryRecipeSnapshot(recipeByMenuId);

  // H3: the server owns availability. Reject the whole order if any resolved
  // catalog item is explicitly unavailable/out of stock. The client cannot
  // override this with forged flags, and no line is persisted.
  const unavailable = items.find((it) =>
    isMenuItemUnavailable(snapshot.get(String(it.itemId)))
  );
  if (unavailable) {
    throw new OrderCatalogError(
      `Menu item ${unavailable.itemId} is not available for ordering`,
      400,
      "MENU_ITEM_UNAVAILABLE"
    );
  }

  items = items.map((it) => {
    // Every id was proven to resolve above, so the catalog record is the only
    // source of name/price. A record with no usable name/price rejects the
    // order instead of falling back to client-supplied values (C1).
    const cat = snapshot.get(String(it.itemId));
    const catalogName = getLocalizedSingleString(cat?.name).trim();
    const catalogPrice = Number(cat?.price);
    if (!catalogName || !Number.isFinite(catalogPrice) || catalogPrice < 0) {
      throw new Error(
        `Menu item ${it.itemId} has no usable catalog name/price: the order cannot be created from client-supplied values`
      );
    }
    const lineId = new mongoose.Types.ObjectId();
    // Server-authoritative price/name/type snapshot (single shared helper above).
    const { price, name, type } = resolveCatalogLine(cat, it);
    const itemId = new mongoose.Types.ObjectId(String(cat._id));
    const components = Array.isArray(it.components) ? it.components.map((c) => ({ ...c })) : [];
    return {
      lineId,
      name,
      price,
      quantity: it.quantity,
      type,
      isExternal: false,
      isExtraItem: false,
      unit: null,
      // H1.4: freeze the resolved policy for this line. Mixed-policy orders keep
      // a distinct value per line; the order itself carries no single policy.
      inventoryPolicySnapshot:
        policyByMenuId.get(String(it.itemId)) || resolveInventoryPolicy(cat),
      cancelled: false,
      cancelledAt: null,
      cancelledBy: null,
      cancelledStation: null,
      cancelReason: null,
      components,
      ...(itemId ? { itemId } : {}),
    };
  });

  // Resolve every Extra Item component in one batch. Name, selling price, unit,
  // stock link and deduction quantity are server-owned; any invalid/disabled
  // extra fails closed before the order is written.
  const componentRefs = items.flatMap((it) => it.components || []);
  if (componentRefs.length > 0) {
    const resolved = await resolveExtraComponents(conn, componentRefs);
    let cursor = 0;
    items = items.map((it) => {
      const components = (it.components || []).map(() => resolved[cursor++]);
      return { ...it, components };
    });
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
  const hasHotDrink = items.some((i) => i.type === "HOT_DRINK");
  const Order = getOrderModel(conn);
  const doc = new Order({
    orderNumber: await genOrderNumber(conn),
    tableNumber,
    waiterName,
    waiterId,
    waiterNumber,
    waiterInfo,
    // kitchen/barista/hot-drink IDs are set only on READY transition
    kitchenStaffId: null,
    baristaStaffId: null,
    hotDrinkStaffId: null,
    status: "PENDING",
    kitchenStatus: hasFood ? "PENDING" : null,
    baristaStatus: hasDrink ? "PENDING" : null,
    hotDrinkStatus: hasHotDrink ? "PENDING" : null,
    kitchenPreparingAt: null,
    kitchenReadyAt: null,
    baristaPreparingAt: null,
    baristaReadyAt: null,
    hotDrinkPreparingAt: null,
    hotDrinkReadyAt: null,
    items,
    totalAmount,
    paymentMethod,
    inventoryRecipeSnapshot,
  });

  // Phase 2.1: the MenuItem version bump and the order insert share one
  // transaction. Classification writes the same document conditionally, so
  // the two flows cannot both commit with a stale policy.
  // Phase 2.1.1: the inner transaction runner is limited to one attempt for
  // order flows. Both the Order document and these version entries are rebuilt
  // by the outer `createOrder` retry on version conflicts or transient errors,
  // so an aborted attempt's mutable state is never reused.
  const versionEntries = uniqueIds.map((id) => ({
    menuItemId: id,
    expectedVersion: policyVersions.get(id),
    timestamps: false,
  }));
  const persistOrder = async (session) => {
    await bumpMenuItemPolicyVersions(conn, versionEntries, session);
    await doc.save({ session });
    return doc;
  };

  // Extra Items fail closed: reserve their linked stock BEFORE persisting the
  // order, reject if any extra-linked row is short, and release the hold if the
  // order write itself fails. Orders without extras keep the existing
  // non-blocking post-save reservation hook.
  if (hasExtraComponents(items)) {
    try {
      await ensureOrderInventoryReservation(conn, doc);
      await assertExtraStockReserved(conn, doc);
      return await runPolicyVersionTransactionOnce(conn, persistOrder);
    } catch (err) {
      await runInventoryHook("release extra reservation after failed create", doc, () =>
        releaseOrderInventory(conn, doc, { reason: "ORDER_CREATE_FAILED" })
      );
      throw err;
    }
  }

  const saved = await runPolicyVersionTransactionOnce(conn, persistOrder);
  // Phase 1: identify shortage and hold available stock before preparation.
  // A failure here never blocks order intake; the PREPARING gate retries.
  await runInventoryHook("reservation create", saved, () =>
    ensureOrderInventoryReservation(conn, saved)
  );
  return saved;
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
  const isHotDrink = role === "HOT_DRINK";
  const isManager = role === "MANAGER";

  // Canonical strict sequence per station: PENDING -> PREPARING -> READY.
  // A pre-read classifies early with exact errors; the atomic filter below
  // repeats every guard (terminal + active lines + expected station state) so a
  // concurrent change misses cleanly into the miss-path instead of corrupting.
  const pre = await Order.findOne(buildOrderQuery(identifier))
    .select(
      "orderNumber status items kitchenStatus baristaStatus hotDrinkStatus inventoryRecipeSnapshot"
    )
    .lean();
  if (!pre) throw new Error("Order not found");
  if (isTerminalOrderStatus(pre.status)) {
    throw new Error("Order is in a terminal state");
  }
  const preHasFood = (pre.items || []).some((i) => i.type === "FOOD" && !i.cancelled);
  const preHasDrink = (pre.items || []).some((i) => i.type === "DRINK" && !i.cancelled);
  const preHasHotDrink = (pre.items || []).some((i) => i.type === "HOT_DRINK" && !i.cancelled);
  if (isKitchen && !preHasFood) throw new Error("Cannot update order: order has no active FOOD items for Kitchen");
  if (isBarista && !preHasDrink) throw new Error("Cannot update order: order has no active DRINK items for Barista");
  if (isHotDrink && !preHasHotDrink) throw new Error("Cannot update order: order has no active HOT_DRINK items for Jebena Buna");
  // Stations this request will touch (manager/no-role: every active station).
  const touched = [];
  if (isKitchen) touched.push("kitchen");
  else if (isBarista) touched.push("barista");
  else if (isHotDrink) touched.push("hotDrink");
  else {
    if (preHasFood) touched.push("kitchen");
    if (preHasDrink) touched.push("barista");
    if (preHasHotDrink) touched.push("hotDrink");
  }
  const stationLabelOf = (s) => (s === "kitchen" ? "KITCHEN" : s === "barista" ? "BARISTA" : "HOT_DRINK");
  const currentOf = (s) => (s === "kitchen" ? pre.kitchenStatus : s === "barista" ? pre.baristaStatus : pre.hotDrinkStatus);
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

  // Phase 1 pre-preparation gate: no station may start work until every
  // recipe-linked requirement is either held or covered by a Manager-approved
  // shortage snapshot. Runs before the atomic status write, so a blocked
  // request leaves the order and station state untouched.
  if (status === "PREPARING") {
    await assertOrderInventoryReady(conn, pre);

    // Phase 1.1: ingredients are physically used when preparation starts, not
    // when payment eventually happens. Consume the reservation before flipping
    // the station to PREPARING so a prepared-then-cancelled order can never
    // return its ingredients to sellable stock. This is idempotent: a second
    // station start or a payment retry sees CONSUMED and does not deduct again.
    const consumption = await consumeOrderInventory(conn, pre, {
      actorId: opts.staffId,
      trigger: "PREPARING",
    });
    if (!consumption?.success) {
      throw new InventoryReservationError(
        consumption?.error || "Inventory consumption failed; preparation is blocked.",
        Number.isInteger(consumption?.status) ? consumption.status : 409,
        consumption?.code || "PREPARATION_CONSUMPTION_FAILED"
      );
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
      : isHotDrink
        ? { type: "HOT_DRINK", cancelled: { $ne: true } }
        : null;
  const filter = {
    ...buildOrderQuery(identifier),
    status: { $nin: [...TERMINAL_ORDER_STATUSES] },
    ...(stationMatch ? { items: { $elemMatch: stationMatch } } : {}),
  };
  // Race-proof the strict sequence: the expected pre-write station state is part
  // of the atomic filter, so a concurrent station transition misses cleanly.
  for (const s of touched) {
    const key = s === "kitchen" ? "kitchenStatus" : s === "barista" ? "baristaStatus" : "hotDrinkStatus";
    filter[key] = status === "READY" ? "PREPARING" : { $in: [null, "PENDING"] };
  }

  // Station update flags — mirror original branching. HOT_DRINK is a peer of
  // KITCHEN/BARISTA; the existing two-station paths are bitwise unchanged.
  let updateKitchenExpr;
  let updateBaristaExpr;
  let updateHotDrinkExpr;
  if (isKitchen) {
    updateKitchenExpr = true;
    updateBaristaExpr = false;
    updateHotDrinkExpr = false;
  } else if (isBarista) {
    updateKitchenExpr = false;
    updateBaristaExpr = true;
    updateHotDrinkExpr = false;
  } else if (isHotDrink) {
    updateKitchenExpr = false;
    updateBaristaExpr = false;
    updateHotDrinkExpr = true;
  } else {
    // Manager OR no-role fallback: update relevant station(s); if no station
    // is present, update all (legacy behavior).
    const hasNeither = {
      $and: [{ $not: ["$__hasFood"] }, { $not: ["$__hasDrink"] }, { $not: ["$__hasHotDrink"] }],
    };
    updateKitchenExpr = { $or: ["$__hasFood", hasNeither] };
    updateBaristaExpr = { $or: ["$__hasDrink", hasNeither] };
    updateHotDrinkExpr = { $or: ["$__hasHotDrink", hasNeither] };
  }

  // Overall status expression (uses already-updated station statuses).
  // READY only when every PRESENT active station is READY; single-station and
  // legacy two-station orders keep their exact prior behavior.
  let overallExpr;
  if (status === "PENDING") overallExpr = "PENDING";
  else if (status === "PREPARING") overallExpr = "PREPARING";
  else {
    overallExpr = {
      $cond: [
        {
          $and: [
            { $or: [{ $not: ["$__hasFood"] }, { $eq: ["$kitchenStatus", "READY"] }] },
            { $or: [{ $not: ["$__hasDrink"] }, { $eq: ["$baristaStatus", "READY"] }] },
            { $or: [{ $not: ["$__hasHotDrink"] }, { $eq: ["$hotDrinkStatus", "READY"] }] },
          ],
        },
        "READY",
        "PREPARING",
      ],
    };
  }

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
  const hasHotDrinkExpr = {
    $anyElementTrue: {
      $map: {
        input: { $ifNull: ["$items", []] },
        as: "it",
        in: { $and: [{ $eq: ["$$it.type", "HOT_DRINK"] }, { $ne: ["$$it.cancelled", true] }] },
      },
    },
  };

  // READY attribution (auditable, never overwrites existing).
  const kExplicitOid = toOid(opts.kitchenStaffId);
  const bExplicitOid = toOid(opts.baristaStaffId);
  const hExplicitOid = toOid(opts.hotDrinkStaffId);
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
  let hRoleOid = null;
  let hRoleShouldSet = false;
  if (isHotDrink) {
    hRoleOid = role === "HOT_DRINK" ? sOid : null;
    hRoleShouldSet = true;
  } else if (isManager) {
    hRoleOid = role === "MANAGER" ? sOid : null;
    hRoleShouldSet = "$__updateHotDrink";
  }
  const kCandidate = kExplicitOid || kRoleOid;
  const bCandidate = bExplicitOid || bRoleOid;
  const hCandidate = hExplicitOid || hRoleOid;
  const kShouldSet = kExplicitOid ? true : kRoleShouldSet;
  const bShouldSet = bExplicitOid ? true : bRoleShouldSet;
  const hShouldSet = hExplicitOid ? true : hRoleShouldSet;

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
  const hAttrExpr = {
    $cond: [
      {
        $and: [
          hShouldSet,
          { $ne: [hCandidate, null] },
          { $eq: [{ $ifNull: ["$hotDrinkStaffId", null] }, null] },
        ],
      },
      hCandidate,
      "$hotDrinkStaffId",
    ],
  };

  const pipeline = [
    { $set: { __hasFood: hasFoodExpr, __hasDrink: hasDrinkExpr, __hasHotDrink: hasHotDrinkExpr } },
    {
      $set: {
        __updateKitchen: updateKitchenExpr,
        __updateBarista: updateBaristaExpr,
        __updateHotDrink: updateHotDrinkExpr,
      },
    },
    {
      $set: {
        kitchenStatus: { $cond: ["$__updateKitchen", status, "$kitchenStatus"] },
        baristaStatus: { $cond: ["$__updateBarista", status, "$baristaStatus"] },
        hotDrinkStatus: { $cond: ["$__updateHotDrink", status, "$hotDrinkStatus"] },
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
        hotDrinkPreparingAt: {
          $cond: [
            {
              $and: [
                "$__updateHotDrink",
                { $eq: [status, "PREPARING"] },
                { $eq: [{ $ifNull: ["$hotDrinkPreparingAt", null] }, null] },
              ],
            },
            now,
            "$hotDrinkPreparingAt",
          ],
        },
        hotDrinkReadyAt: {
          $cond: [
            {
              $and: [
                "$__updateHotDrink",
                { $eq: [status, "READY"] },
                { $eq: [{ $ifNull: ["$hotDrinkReadyAt", null] }, null] },
              ],
            },
            now,
            "$hotDrinkReadyAt",
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
    pipeline.push({
      $set: {
        kitchenStaffId: kAttrExpr,
        baristaStaffId: bAttrExpr,
        hotDrinkStaffId: hAttrExpr,
      },
    });
  }
  pipeline.push({
    $unset: [
      "__hasFood",
      "__hasDrink",
      "__hasHotDrink",
      "__updateKitchen",
      "__updateBarista",
      "__updateHotDrink",
    ],
  });

  const doc = await Order.findOneAndUpdate(filter, pipeline, {
    returnDocument: "after",
    updatePipeline: true,
  });

  if (!doc) {
    // Miss path only: reproduce exact error semantics of the prior read-first flow.
    const existing = await Order.findOne(buildOrderQuery(identifier))
      .select("status items kitchenStatus baristaStatus hotDrinkStatus")
      .lean();
    if (!existing) throw new Error("Order not found");
    if (isTerminalOrderStatus(existing.status)) {
      throw new Error("Order is in a terminal state");
    }
    const hasFood = (existing.items || []).some((i) => i.type === "FOOD" && !i.cancelled);
    const hasDrink = (existing.items || []).some((i) => i.type === "DRINK" && !i.cancelled);
    const hasHotDrink = (existing.items || []).some((i) => i.type === "HOT_DRINK" && !i.cancelled);
    // Worded with "Cannot" so the existing route mapper classifies this stale-client
    // lifecycle miss as HTTP 400 (never generic 500). No mutation occurs here.
    if (isKitchen && !hasFood) throw new Error("Cannot update order: order has no active FOOD items for Kitchen");
    if (isBarista && !hasDrink) throw new Error("Cannot update order: order has no active DRINK items for Barista");
    if (isHotDrink && !hasHotDrink) throw new Error("Cannot update order: order has no active HOT_DRINK items for Jebena Buna");
    // Strict-sequence recheck on fresh state (race: station moved between pre-read
    // and write). Same rules as above; first violation reports precisely.
    const reTouched = [];
    if (isKitchen) reTouched.push("kitchen");
    else if (isBarista) reTouched.push("barista");
    else if (isHotDrink) reTouched.push("hotDrink");
    else {
      if (hasFood) reTouched.push("kitchen");
      if (hasDrink) reTouched.push("barista");
      if (hasHotDrink) reTouched.push("hotDrink");
    }
    for (const s of reTouched) {
      const cur =
        (s === "kitchen"
          ? existing.kitchenStatus
          : s === "barista"
            ? existing.baristaStatus
            : existing.hotDrinkStatus) ?? null;
      const label = s === "kitchen" ? "KITCHEN" : s === "barista" ? "BARISTA" : "HOT_DRINK";
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

// Consume a reservation exactly once when an order becomes PAID. Payment has
// already committed; inventory problems are logged and never rolled back.
async function applyPaidInventory(conn, doc, actorId) {
  try {
    const result = await consumeOrderInventory(conn, doc, { actorId, trigger: "PAYMENT" });
    if (!result?.success) {
      logEvent("error", "inventory_consumption_failed", {
        orderId: String(doc._id),
        trigger: "PAYMENT",
        warnings: result?.warnings,
        errorMessage: result?.error,
      });
      // The order is already PAID. Never leave a permanent hold behind: an
      // unconsumed reservation would silently reduce sellable stock forever.
      // Only a positively confirmed "not consumed" verdict may release holds.
      // An inconclusive probe (null/error) or a late/unknown commit must never
      // void or reclassify evidence; the reservation is preserved for manual
      // investigation instead.
      const alreadyConsumed = await runInventoryHook("check consumed after failed consumption", doc, () =>
        isOrderInventoryConsumed(conn, doc)
      );
      if (alreadyConsumed === false) {
        // recordVoid:false is a second barrier: even a wrong or late false
        // probe cannot reclassify consumed SaleDeduction movements as Waste.
        await runInventoryHook("release after failed consumption", doc, () =>
          releaseOrderInventory(conn, doc, { reason: "CONSUMPTION_FAILED", recordVoid: false })
        );
      } else if (alreadyConsumed !== true) {
        // Unknown commit, probe error, or any non-boolean verdict. Do not
        // release: the payment is durable and the stock may already be gone.
        logEvent("error", "inventory_consumption_probe_unknown", {
          orderId: String(doc._id),
          trigger: "PAYMENT",
          probeResult: alreadyConsumed === null ? "null" : typeof alreadyConsumed,
          consumptionCode: result?.code ?? null,
        });
      }
    } else if (result.warnings?.length && !result.skipped) {
      logEvent("warn", "inventory_consumption_warnings", {
        orderId: String(doc._id),
        trigger: "PAYMENT",
        warnings: result.warnings,
      });
    }
  } catch (err) {
    logEvent("error", "inventory_consumption_error", {
      orderId: String(doc._id),
      trigger: "PAYMENT",
      errorName: err?.name,
      errorMessage: err?.message || String(err),
      errorCode: err?.code,
    });
  }
}

// Phase 2.5 WP-01 — payment identity freeze.
//
// The frozen identity is `paymentMethod` + `paymentAccountId` +
// `paymentAccountSnapshot`. The lock marker is the existing `paidAt` field; no
// new schema field is introduced. These helpers are pure so the rule can be
// tested without a database.
export const PAYMENT_METHOD_IMMUTABLE = "PAYMENT_METHOD_IMMUTABLE";

// Canonicalize a method for new writes: legacy TELEBIRR becomes TRANSFER while
// historical reads keep the stored TELEBIRR value.
export function normalizePaymentMethodForWrite(method) {
  const pm = VALID_PAYMENT_METHODS.includes(method) ? method : null;
  return pm === "TELEBIRR" ? "TRANSFER" : pm;
}

// A stored legacy method and its canonical form are the same identity.
export function paymentMethodsEquivalent(a, b) {
  const na = normalizePaymentMethodForWrite(a);
  const nb = normalizePaymentMethodForWrite(b);
  return !!na && !!nb && na === nb;
}

// Frozen once paidAt exists or the order is PAID. Legacy PAID orders whose
// paidAt is null stay frozen too — Phase 2.5 does not backfill paidAt.
export function isFrozenPaymentIdentity(order) {
  return !!order && (!!order.paidAt || order.status === "PAID");
}

function paymentMethodImmutableError() {
  const err = new Error("Payment method cannot be changed after payment");
  err.name = "PaymentIdentityError";
  err.status = 409;
  err.code = PAYMENT_METHOD_IMMUTABLE;
  return err;
}

export async function payOrder(conn, identifier, { paymentMethod, paymentAccountId, actorId } = {}) {
  const Order = getOrderModel(conn);
  const now = new Date();
  const pm = normalizePaymentMethodForWrite(paymentMethod);
  let paymentAccOid = null;
  let paymentSnapshot = null;
  // Stock Policy A: a shortage blocks payment even on a legacy/direct path.
  // The same read supplies the frozen-identity marker below, so the gate adds
  // no extra round trip. A genuinely missing order keeps the prior semantics.
  const current = await Order.findOne(buildOrderQuery(identifier)).lean();
  if (!current) throw new Error("Order not found");
  // An already-PAID order is an idempotent retry: the payable gate ran before
  // the original commit, and a shortage can never reach PAID. Re-running the
  // gate could only 409 on a housekeeping state left by a failed consumption
  // (released hold), which must not make a committed payment look failed.
  // The atomic write below keeps the retry read-only (identity frozen).
  if (current.status !== "PAID") {
    await assertOrderInventoryPayable(conn, current);
  }
  let frozenIdentity = false;
  if (pm === "TRANSFER") {
    frozenIdentity = isFrozenPaymentIdentity(current);
  }
  // Validate the transfer account server-side for genuinely new/unpaid
  // transfers only (not trusted client total/account). A frozen TRANSFER
  // retry keeps the stored identity and never needs the account lookup.
  if (pm === "TRANSFER") {
    if (!frozenIdentity) {
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
    }
  } else if (pm === "CASH") {
    if (paymentAccountId) throw new Error("paymentAccountId must not be provided for Cash payments");
  } else if (paymentAccountId) {
    throw new Error("paymentAccountId is only allowed for Transfer payments");
  }
  // For already PAID retry, ensure same account (or no account change) to prevent double-pay with different account
  // This check is done after fetching existing order in miss path, but also enforce in pipeline via conditional set

  // First-payment identity. The literal `paymentMethod: pm` shape is retained
  // for the Phase 2.3 source contract; the $cond below applies it only while
  // paidAt is still null. On any retry the stored identity wins.
  const firstPayment = {
    paymentMethod: pm,
    paymentAccountId: paymentAccOid,
    paymentAccountSnapshot: paymentSnapshot,
  };
  const isFirstPayment = {
    $and: [
      { $eq: [{ $ifNull: ["$paidAt", null] }, null] },
      { $ne: ["$status", "PAID"] },
    ],
  };

  // Atomic payment: enforce a payable state (SERVED/READY, or already PAID for
  // idempotent retry) and stamp timestamps in a single write (replaces the prior
  // Order.findOne + findOneAndUpdate = 2 round trips). Idempotent: paidAt/
  // completedAt/servedAt are only set when currently null. Payment identity is
  // frozen after the first PAID: method and account are written only while
  // paidAt is null and preserved on every retry. Station state is untouched.
  const filter = {
    ...buildOrderQuery(identifier),
    status: { $in: ["SERVED", "READY", "PAID"] },
  };
  const pipeline = [
    {
      $set: {
        status: "PAID",
        updatedAt: now,
        ...(pm
          ? {
              paymentMethod: {
                $cond: [isFirstPayment, firstPayment.paymentMethod, "$paymentMethod"],
              },
            }
          : {}),
        // Payment account identity is guarded by the same paidAt marker so a
        // retry can never pair a new account with an old method (torn identity).
        ...(paymentAccOid
          ? {
              paymentAccountId: {
                $cond: [isFirstPayment, firstPayment.paymentAccountId, "$paymentAccountId"],
              },
              paymentAccountSnapshot: {
                $cond: [isFirstPayment, firstPayment.paymentAccountSnapshot, "$paymentAccountSnapshot"],
              },
            }
          : pm === "CASH"
          ? {
              paymentAccountId: {
                $cond: [isFirstPayment, null, "$paymentAccountId"],
              },
              paymentAccountSnapshot: {
                $cond: [isFirstPayment, null, "$paymentAccountSnapshot"],
              },
            }
          : {}),
        paidAt: {
          $cond: [isFirstPayment, now, "$paidAt"],
        },
        completedAt: {
          $cond: [
            { $and: [isFirstPayment, { $eq: [{ $ifNull: ["$completedAt", null] }, null] }] },
            now,
            "$completedAt",
          ],
        },
        servedAt: {
          $cond: [
            { $and: [isFirstPayment, { $eq: [{ $ifNull: ["$servedAt", null] }, null] }] },
            now,
            "$servedAt",
          ],
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

  // A different-method retry preserves the first identity. Log method names
  // only — never account numbers, tokens, or PINs.
  if (pm && doc.paymentMethod && !paymentMethodsEquivalent(pm, doc.paymentMethod)) {
    logEvent("info", "payment_method_preserved", {
      orderId: String(doc._id),
      actorId: actorId || null,
      requestedMethod: pm,
      storedMethod: doc.paymentMethod,
      result: "PRESERVED",
    });
  }

  // Phase 1: consume the exact reservation created before preparation. The
  // legacy post-PAID planner/executor pair is replaced because it allowed
  // unconditional stock decrements and duplicate multi-ingredient movements.
  await applyPaidInventory(conn, doc, actorId);

  return doc;
}

// KDS staff dismiss a live ticket from the board. The row stays in the
// database (sales history preserved) but drops out of the ACTIVE query,
// which only covers PENDING / PREPARING / READY.
export async function archiveOrder(conn, identifier) {
  const Order = getOrderModel(conn);
  // Atomic guard: the write itself re-checks the terminal-state invariant, so a
  // payment that commits after this read can never be overwritten as ARCHIVED.
  // The miss path below reproduces the exact prior error/idempotent semantics.
  const archived = await Order.findOneAndUpdate(
    {
      ...buildOrderQuery(identifier),
      status: { $nin: ["PAID", "ARCHIVED", "CANCELLED"] },
    },
    { $set: { status: "ARCHIVED", updatedAt: new Date() } },
    { returnDocument: "after", runValidators: false }
  );
  if (!archived) {
    const existing = await Order.findOne(buildOrderQuery(identifier));
    if (!existing) throw new Error("Order not found");
    if (existing.status === "PAID") {
      throw new Error("Cannot archive a paid order");
    }
    if (existing.status === "ARCHIVED" || existing.status === "CANCELLED") {
      return existing;
    }
    throw new Error("Update failed");
  }
  // Before preparation this returns the hold. After preparation the stock is
  // already physically consumed; archiving must preserve that evidence and
  // never void or reclassify it (recordVoid: false).
  await runInventoryHook("release after archive", archived, () =>
    releaseOrderInventory(conn, archived, { reason: "ARCHIVED", recordVoid: false })
  );
  return archived;
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
  await runInventoryHook("release after waiter cancel", docAfter, () =>
    releaseOrderInventory(conn, docAfter, {
      reason: "WAITER_CANCELLED",
      actorId: actorOid,
      source: "ORDER",
    })
  );
  return docAfter;
}

// Manager voids the whole ticket (terminal). PENDING/PREPARING/READY only.
// Inventory behavior is phase-dependent: before preparation the hold is
// released; after preparation the consumed stock is recorded as an auditable
// void/waste and is never returned to availability.
export async function cancelOrder(conn, identifier, opts = {}) {
  const Order = getOrderModel(conn);
  const order = await Order.findOne(buildOrderQuery(identifier));
  if (!order) throw new Error("Order not found");
  if (order.status === "PAID" || order.status === "CANCELLED") {
    throw new Error("Cannot cancel a paid or already-cancelled order");
  }
  const actorOid =
    opts.staffId && mongoose.isValidObjectId(String(opts.staffId))
      ? new mongoose.Types.ObjectId(String(opts.staffId))
      : null;
  const reasonRaw = typeof opts.reason === "string" ? opts.reason.trim().slice(0, 200) : "";
  const reason = reasonRaw || "MANAGER_CANCELLED";
  // Atomic guard: never overwrite a payment/cancellation that commits after the
  // read above. Without this filter a concurrent confirmPayment()/payOrder()
  // could be silently reverted from PAID to CANCELLED (financial evidence lost).
  const cancelled = await Order.findOneAndUpdate(
    {
      ...buildOrderQuery(identifier),
      status: { $nin: ["PAID", "CANCELLED"] },
    },
    { $set: { status: "CANCELLED", updatedAt: new Date() } },
    { returnDocument: "after", runValidators: false }
  );
  if (!cancelled) {
    const existing = await Order.findOne(buildOrderQuery(identifier)).select("status").lean();
    if (!existing) throw new Error("Order not found");
    if (existing.status === "PAID" || existing.status === "CANCELLED") {
      throw new Error("Cannot cancel a paid or already-cancelled order");
    }
    throw new Error("Update failed");
  }
  await runInventoryHook("release after manager cancel", cancelled, () =>
    releaseOrderInventory(conn, cancelled, {
      reason,
      actorId: actorOid,
      source: "ORDER",
    })
  );
  return cancelled;
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
  const isHotDrink = role === "HOT_DRINK";
  const isManager = role === "MANAGER";
  if (!isKitchen && !isBarista && !isHotDrink && !isManager) throw new Error("Forbidden: CANCEL_ITEM requires KITCHEN/BARISTA/HOT_DRINK/MANAGER");
  const actorOid = toOid(opts.staffId || opts.actorId);
  const reasonRaw = typeof opts.reason === "string" ? opts.reason.trim().slice(0, 200) : "";
  const reason = reasonRaw ? reasonRaw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") : null;
  if (reason && (/<script/i.test(reason) || /javascript:/i.test(reason))) throw new Error("Invalid cancel reason");

  // Read to validate station ownership and idempotency before atomic write
  const existing = await Order.findOne(buildOrderQuery(identifier)).select("status items kitchenStatus baristaStatus hotDrinkStatus").lean();
  if (!existing) throw new Error("Order not found");
  if (isTerminalOrderStatus(existing.status)) throw new Error("Cannot cancel line of order in terminal state");
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
  if (isHotDrink && target.type !== "HOT_DRINK") throw new Error("Jebena Buna can only cancel HOT_DRINK items");
  // Preparation-finished lines cannot be cancelled: overall READY, or the
  // target line's own station already READY. Stale clicks fail cleanly (400).
  if (
    existing.status === "READY" ||
    (target.type === "FOOD" && existing.kitchenStatus === "READY") ||
    (target.type === "DRINK" && existing.baristaStatus === "READY") ||
    (target.type === "HOT_DRINK" && existing.hotDrinkStatus === "READY")
  ) {
    throw new Error("Cannot cancel an item that is already finished preparing");
  }
  const station = isKitchen ? "KITCHEN" : isBarista ? "BARISTA" : isHotDrink ? "HOT_DRINK" : "MANAGER";

  // Atomic item-level update — touches only matched array element, no whole-order read-modify-write.
  // Line identity, active state and station ownership are evaluated against the SAME
  // array element via $elemMatch. A top-level "items.cancelled": { $ne: true } must
  // NOT be used here: MongoDB evaluates it as "no element equals true", so after one
  // line is cancelled the filter could never match again and every subsequent line
  // cancellation fell through to "Update failed" (HTTP 500).
  const filter = {
    ...buildOrderQuery(identifier),
    status: { $nin: [...TERMINAL_ORDER_STATUSES] },
    items: {
      $elemMatch: {
        lineId: lineOid,
        cancelled: { $ne: true },
        ...(isKitchen
          ? { type: "FOOD" }
          : isBarista
            ? { type: "DRINK" }
            : isHotDrink
              ? { type: "HOT_DRINK" }
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
  if (isHotDrink) arrayFilters[0]["elem.type"] = "HOT_DRINK";

  const docAfter = await Order.findOneAndUpdate(filter, update, { arrayFilters, returnDocument: "after", runValidators: false });
  if (!docAfter) {
    // Re-evaluate for precise error — must mirror pre-read terminal list including PAYMENT_PENDING (race fix)
    const re = await Order.findOne(buildOrderQuery(identifier)).select("status items kitchenStatus baristaStatus hotDrinkStatus").lean();
    if (!re) throw new Error("Order not found");
    if (isTerminalOrderStatus(re.status)) throw new Error("Cannot cancel line of order in terminal state");
    const t2 = (re.items || []).find((it) => it.lineId && String(it.lineId) === String(lineOid));
    if (!t2) throw new Error("Order item not found");
    if (t2.cancelled) throw new Error("Order item already cancelled");
    if (isKitchen && t2.type !== "FOOD") throw new Error("Kitchen can only cancel FOOD items");
    if (isBarista && t2.type !== "DRINK") throw new Error("Barista can only cancel DRINK items");
    if (isHotDrink && t2.type !== "HOT_DRINK") throw new Error("Jebena Buna can only cancel HOT_DRINK items");
    if (
      re.status === "READY" ||
      (t2.type === "FOOD" && re.kitchenStatus === "READY") ||
      (t2.type === "DRINK" && re.baristaStatus === "READY") ||
      (t2.type === "HOT_DRINK" && re.hotDrinkStatus === "READY")
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
  const activeHasHotDrink = active.some((it) => it.type === "HOT_DRINK");
  const normKitchen = activeHasFood ? (docAfter.kitchenStatus ?? null) : null;
  const normBarista = activeHasDrink ? (docAfter.baristaStatus ?? null) : null;
  const normHotDrink = activeHasHotDrink ? (docAfter.hotDrinkStatus ?? null) : null;
  let normStatus = docAfter.status;
  if (active.length === 0) {
    // All lines cancelled → whole order CANCELLED (distinct from ARCHIVED).
    normStatus = "CANCELLED";
  } else {
    // All PRESENT stations must be READY for overall READY; PREPARING when any
    // has started; otherwise PENDING. For one or two stations this is exactly
    // the prior behavior (single station / mixed kitchen+barista).
    const present = [];
    if (activeHasFood) present.push(normKitchen);
    if (activeHasDrink) present.push(normBarista);
    if (activeHasHotDrink) present.push(normHotDrink);
    if (present.length === 1) {
      const only = present[0];
      normStatus = only === "READY" ? "READY" : only === "PREPARING" ? "PREPARING" : "PENDING";
    } else {
      const allDone = present.every((s) => s === "READY");
      const anyStarted = present.some((s) => s === "READY" || s === "PREPARING");
      normStatus = allDone ? "READY" : anyStarted ? "PREPARING" : "PENDING";
    }
  }
  // Inventory sync after a line-level cancel. Three distinct outcomes:
  //  * Stock not yet consumed → reconcile the reservation to the remaining
  //    active lines (or release holds if every line is now cancelled).
  //  * Stock already consumed at preparation start → never restore it. Record
  //    an auditable line-level void (lineId/station/reason); a whole-order
  //    cancellation (all lines gone) records the order-level void and
  //    reclassifies its sale deduction as waste.
  const syncInventoryAfterLineChange = async (doc) => {
    const consumed = await runInventoryHook("check consumed before line sync", doc, () =>
      isOrderInventoryConsumed(conn, doc)
    );
    if (consumed) {
      if (doc.status === "CANCELLED") {
        return runInventoryHook("void after all lines cancelled", doc, () =>
          releaseOrderInventory(conn, doc, {
            reason: reason || "LINE_CANCELLED",
            actorId: actorOid,
            source: "ORDER",
          })
        );
      }
      return runInventoryHook("void after post-preparation line cancel", doc, () =>
        recordPostPreparationVoid(conn, doc, {
          reason: reason || "LINE_CANCELLED",
          actorId: actorOid,
          source: "LINE",
          lineId: lineOid,
          station,
        })
      );
    }
    if (doc.status === "CANCELLED") {
      return runInventoryHook("release after all lines cancelled", doc, () =>
        releaseOrderInventory(conn, doc, {
          reason: "CANCELLED",
          actorId: actorOid,
          source: "ORDER",
        })
      );
    }
    return runInventoryHook("reservation reconcile after line cancel", doc, () =>
      reconcileOrderInventory(conn, doc)
    );
  };

  if (
    normKitchen !== (docAfter.kitchenStatus ?? null) ||
    normBarista !== (docAfter.baristaStatus ?? null) ||
    normHotDrink !== (docAfter.hotDrinkStatus ?? null) ||
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
      {
        $set: {
          kitchenStatus: normKitchen,
          baristaStatus: normBarista,
          hotDrinkStatus: normHotDrink,
          status: normStatus,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after", runValidators: false }
    );
    const settled = normalized || docAfter;
    await syncInventoryAfterLineChange(settled);
    return settled;
  }
  await syncInventoryAfterLineChange(docAfter);
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
// Phase 2.1: an add-line attempt can lose the policyVersion race against a
// concurrent Manager classification. Retry the whole edit so the catalog and
// policy are re-resolved; untouched lines are rebuilt from the stored order.
export async function editOrderItems(conn, identifier, changes, opts = {}) {
  let lastConflict = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await editOrderItemsAttempt(conn, identifier, changes, opts);
    } catch (err) {
      if (isRebuildableRetryError(err) && attempt < 2) {
        lastConflict = err;
        continue;
      }
      throw err;
    }
  }
  throw lastConflict;
}

async function editOrderItemsAttempt(conn, identifier, changes, opts = {}) {
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
  let catalogReadFailed = false;
  if (addMenuIds.length) {
    try {
      const { getMenuItemModel } = await import("@/lib/models/MenuItem");
      const MenuItem = getMenuItemModel(conn);
      const found = await MenuItem.find({
        _id: { $in: [...new Set(addMenuIds)] },
        isDeleted: { $ne: true },
      }).lean();
      for (const m of found || []) catalog.set(String(m._id), m);
    } catch (err) {
      // C1: a database/query failure is a catalog OUTAGE, not an empty catalog.
      // Remember it and reject the whole edit with a controlled 503 before any
      // write. A genuinely missing/soft-deleted item resolves against a
      // successful query and stays a 404 below. Raw driver details are logged
      // internally and never sent to the client.
      catalogReadFailed = true;
      logEvent("error", "order_catalog_read_failed", {
        op: "edit",
        errorName: err?.name,
        errorMessage: err?.message || String(err),
        errorCode: err?.code,
      });
    }
  }
  if (catalogReadFailed) {
    throw new OrderCatalogError(
      "Menu catalog is temporarily unavailable. Please retry shortly.",
      503,
      "CATALOG_UNAVAILABLE"
    );
  }

  // Phase 2.1: version observed with each added item's catalog snapshot.
  const addVersions = new Map(
    [...new Set(addMenuIds)].map((id) => [
      id,
      normalizePolicyVersion(catalog.get(id)?.policyVersion),
    ])
  );

  // H1.1: the same server-authoritative policy gate used by createOrder is
  // applied to every ADDED catalog line. Only the ids being added are
  // evaluated — unchanged historical lines (legacy UNKNOWN included) are never
  // re-validated, so an open order can still be edited under the compatibility
  // rules. Any invalid add rejects the whole edit before the atomic write.
  const trackedAddIds = [...new Set(addMenuIds)].filter(
    (id) => resolveInventoryPolicy(catalog.get(id)) === "TRACKED"
  );
  const addRecipes = await loadTrackedRecipeMap(conn, trackedAddIds);
  // H1.3: TRACKED lines accepted by this edit get their active Recipe frozen
  // into the order snapshot before the atomic write. Already-captured items are
  // never recaptured, so an immutable capture survives later edits.
  const newlyCapturedRecipes = new Map();

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
      if (!cat) {
        throw new OrderCatalogError(
          `Menu item ${mid} was not found in the catalog`,
          404,
          "CATALOG_ITEM_NOT_FOUND"
        );
      }
      if (isMenuItemUnavailable(cat)) throw new Error("Cannot add unavailable menu item");
      const q = Number(ch.quantity ?? ch.qty ?? 1);
      if (!Number.isInteger(q) || q < 1 || q > 99) throw new Error("quantity must be integer 1-99");
      // H1.1: added lines pass the same explicit-policy gate as createOrder.
      // UNKNOWN / historical EXTERNAL / unusable TRACKED reject the edit.
      const policyCheck = validateOrderLineInventoryPolicy({
        inventoryPolicy: resolveInventoryPolicy(cat),
        recipe: addRecipes.get(mid) || null,
      });
      if (!policyCheck.ok) {
        throw new OrderCatalogError(policyCheck.error, 409, policyCheck.code);
      }
      if (policyCheck.policy === "TRACKED") {
        newlyCapturedRecipes.set(mid, addRecipes.get(mid) || null);
      }
      const snap = resolveCatalogLine(cat, { price: 0, name: "", type: "FOOD" });
      if (!snap.name) throw new Error("Menu item has no usable name");
      working.push({
        lineId: new mongoose.Types.ObjectId(),
        name: snap.name,
        price: snap.price,
        quantity: q,
        type: snap.type,
        isExternal: false,
        isExtraItem: false,
        unit: null,
        // H1.4: freeze the current policy for the newly added line only.
        // Existing lines are copied verbatim above and are never rewritten.
        inventoryPolicySnapshot: policyCheck.policy,
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
    } else if (op === "extra") {
      const lid = ch.lineId ? String(ch.lineId) : null;
      const target = lid ? workingByLine.get(lid) : null;
      if (!target) throw new Error("Order item not found");
      if (target.cancelled) throw new Error("Cannot edit a cancelled order item");
      const extraItemId = ch.extraItemId ? String(ch.extraItemId) : null;
      if (!extraItemId || !mongoose.isValidObjectId(extraItemId)) {
        throw new Error("extraItemId must be valid ObjectId");
      }
      const q = Number(ch.quantity ?? ch.qty ?? 1);
      if (!Number.isInteger(q) || q < 1 || q > 99) throw new Error("quantity must be integer 1-99");
      if (!Array.isArray(target.components)) target.components = [];
      if (target.components.length >= 20) throw new Error("too many components (max 20)");
      const [resolved] = await resolveExtraComponents(conn, [
        { kind: "PRICED_COMPONENT", extraItemId, quantity: q },
      ]);
      target.components.push(resolved);
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
  const updateSet = { items: working, totalAmount, updatedAt: now };
  // H1.3: merge capture for newly added TRACKED lines into the same atomic
  // write. Untouched orders keep their existing snapshot (or null for legacy
  // orders), so no historical capture is rewritten.
  const mergedSnapshot = extendInventoryRecipeSnapshot(
    existing.inventoryRecipeSnapshot,
    newlyCapturedRecipes
  );
  if (mergedSnapshot) updateSet.inventoryRecipeSnapshot = mergedSnapshot;

  // Phase 2.1: only add-line edits serialize. Pure quantity/note/remove edits
  // keep their existing non-transactional atomic path unchanged. Phase 2.1.1:
  // the serialized transaction is single-attempt; the outer retry rebuilds the
  // working order lines, catalog versions and update set from fresh state.
  const writeOrder = async (session) => {
    if (addVersions.size > 0) {
      await bumpMenuItemPolicyVersions(
        conn,
        [...addVersions].map(([id, version]) => ({
          menuItemId: id,
          expectedVersion: version,
          timestamps: false,
        })),
        session
      );
    }
    const updated = await Order.findOneAndUpdate(filter, { $set: updateSet }, {
      session,
      returnDocument: "after",
      runValidators: false,
    });
    if (!updated) {
      // Must throw INSIDE the callback: returning null would let the
      // transaction commit the MenuItem version bump with no order edit.
      throw new PolicyVersionError(
        ORDER_EDIT_CONFLICT,
        409,
        "Order changed during edit; please retry."
      );
    }
    return updated;
  };
  const docAfter =
    addVersions.size > 0
      ? await runPolicyVersionTransactionOnce(conn, writeOrder)
      : await writeOrder(null);
  if (!docAfter) {
    const re = await Order.findOne(buildOrderQuery(identifier)).select("status waiterId").lean();
    if (!re) throw new Error("Order not found");
    if (isWaiter && String(re.waiterId || "") !== String(actorOid)) throw new Error("Forbidden: not your order");
    if (re.status !== "PENDING") throw new Error("Only PENDING orders can be edited");
    throw new Error("Update failed");
  }
  await runInventoryHook("reservation reconcile after item edit", docAfter, () =>
    reconcileOrderInventory(conn, docAfter)
  );
  return docAfter;
}

// Waiter submits payment for cashier verification — does NOT mark PAID.
// Persists method + account snapshot, sets PAYMENT_PENDING, not paidAt, not revenue, no inventory.
export async function submitPaymentForVerification(conn, identifier, { paymentMethod, paymentAccountId, actorId } = {}) {
  const Order = getOrderModel(conn);
  const now = new Date();
  // Stock Policy A: payment submission is blocked while stock is insufficient.
  const gateOrder = await Order.findOne(buildOrderQuery(identifier)).lean();
  if (!gateOrder) throw new Error("Order not found");
  await assertOrderInventoryPayable(conn, gateOrder);
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
  // Stock Policy A: cashier confirmation is blocked while stock is insufficient.
  const gateOrder = await Order.findOne(buildOrderQuery(identifier)).lean();
  if (!gateOrder) throw new Error("Order not found");
  await assertOrderInventoryPayable(conn, gateOrder);
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
  // Cashier-confirmed PAID consumes the pre-preparation reservation once.
  await applyPaidInventory(conn, doc, actorId);
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

// Update payment fields independently of status. Payment identity is frozen
// after the first PAID (paidAt is the lock marker; no new schema field). On a
// PAID order the same method is idempotent and a different method is a stable
// 409 PAYMENT_METHOD_IMMUTABLE; timestamps are never stamped here.
export async function updatePayment(conn, identifier, { paymentMethod, actorId } = {}) {
  const Order = getOrderModel(conn);
  const requestedMethod = normalizePaymentMethodForWrite(paymentMethod);

  // Re-read the current identity. The write below re-checks the freeze marker
  // atomically; this read is only the decision/short-circuit path.
  const existing = await Order.findOne(buildOrderQuery(identifier));
  if (!existing) throw new Error("Order not found");

  if (isFrozenPaymentIdentity(existing)) {
    if (requestedMethod && !paymentMethodsEquivalent(requestedMethod, existing.paymentMethod)) {
      logEvent("warn", "payment_method_conflict", {
        orderId: String(existing._id),
        actorId: actorId || null,
        requestedMethod,
        storedMethod: existing.paymentMethod || null,
        result: "REJECTED",
      });
      throw paymentMethodImmutableError();
    }
    // Same method (or no method requested): idempotent, no mutation and no
    // timestamp stamping — a legacy PAID order with paidAt: null stays frozen.
    return existing;
  }

  const fields = requestedMethod ? { paymentMethod: requestedMethod } : {};
  // Atomic pre-PAID update: the filter re-checks paidAt and PAID so a
  // concurrent payOrder cannot be edited into a torn identity.
  const updated = await Order.findOneAndUpdate(
    {
      ...buildOrderQuery(identifier),
      paidAt: null,
      status: { $ne: "PAID" },
    },
    { $set: { ...fields, updatedAt: new Date() } },
    { returnDocument: "after", runValidators: false }
  );
  if (updated) return updated;

  // Miss: a concurrent writer froze the identity between the read and the
  // write. Re-read and apply the frozen/same-method rules.
  const after = await Order.findOne(buildOrderQuery(identifier))
    .select("status paidAt paymentMethod paymentAccountId paymentAccountSnapshot")
    .lean();
  if (!after) throw new Error("Order not found");
  if (requestedMethod && !paymentMethodsEquivalent(requestedMethod, after.paymentMethod)) {
    logEvent("warn", "payment_method_conflict", {
      orderId: String(after._id),
      actorId: actorId || null,
      requestedMethod,
      storedMethod: after.paymentMethod || null,
      result: "REJECTED",
    });
    throw paymentMethodImmutableError();
  }
  return after;
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
      extraItemId: c.extraItemId ? String(c.extraItemId) : null,
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
      isExtraItem: !!i.isExtraItem,
      unit: i.unit || null,
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
    hotDrinkStaffId: order.hotDrinkStaffId ? String(order.hotDrinkStaffId) : null,
    status: order.status,
    kitchenStatus: order.kitchenStatus || null,
    baristaStatus: order.baristaStatus || null,
    hotDrinkStatus: order.hotDrinkStatus || null,
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
    hotDrinkPreparingAt: order.hotDrinkPreparingAt ? new Date(order.hotDrinkPreparingAt).toISOString() : null,
    hotDrinkReadyAt: order.hotDrinkReadyAt ? new Date(order.hotDrinkReadyAt).toISOString() : null,
    paymentSubmittedAt: order.paymentSubmittedAt ? new Date(order.paymentSubmittedAt).toISOString() : null,
    paymentSubmittedBy: order.paymentSubmittedBy ? String(order.paymentSubmittedBy) : null,
    paymentVerifiedAt: order.paymentVerifiedAt ? new Date(order.paymentVerifiedAt).toISOString() : null,
    paymentVerifiedBy: order.paymentVerifiedBy ? String(order.paymentVerifiedBy) : null,
    paymentRejectedAt: order.paymentRejectedAt ? new Date(order.paymentRejectedAt).toISOString() : null,
    paymentRejectedBy: order.paymentRejectedBy ? String(order.paymentRejectedBy) : null,
    paymentRejectionReason: order.paymentRejectionReason || null,
  };
}
