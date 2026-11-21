// Extra Item policy — DB-free tests.
//
// An Extra Item is a small sellable wrapper around ONE existing canonical
// InventoryItem. It has no recipe: ordering it deducts one linked stock unit per
// selected quantity. Extras are always PRICED_COMPONENT children of the selected
// parent Menu Item, never standalone order lines. The client sends only
// { kind: "PRICED_COMPONENT", extraItemId, quantity }; name, selling price,
// unit, stock link and deduction quantity are server-owned.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import {
  ExtraItemError,
  isExtraItemAvailable,
  assertSupportedStockUnit,
  assertExtraItemEligible,
  toCatalogEntry,
  buildExtraComponent,
  resolveExtraComponents,
  validateExtraItemPayload,
  serializeExtraItem,
  collectExtraStockItemIds,
  hasExtraComponents,
} from "../lib/extraItemService.js";
import {
  STOCK_GROUP,
  STOCK_GROUP_VALUES,
  STOCK_GROUP_LABELS,
  EXTRA_ITEM_CATEGORY,
  normalizeStockGroup,
  stockGroupLabel,
} from "../lib/inventoryCategories.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const exists = (p) => existsSync(join(root, p));

const orderService = src("lib/orderService.js");
const orderModel = src("lib/models/Order.js");
const validateSource = src("lib/validate.js");
const catalogRoute = src("app/api/extra-items/catalog/route.js");
const managerRoute = src("app/api/extra-items/route.js");
const managerItemRoute = src("app/api/extra-items/[id]/route.js");
const waiter = src("app/components/WaiterUI.js");
const inventoryUi = src("app/components/InventoryUI.jsx");

const EXTRA_ID = new mongoose.Types.ObjectId();
const INVENTORY_ID = new mongoose.Types.ObjectId();

function extra(overrides = {}) {
  return {
    _id: EXTRA_ID,
    name: "Extra Injera",
    category: EXTRA_ITEM_CATEGORY,
    sellingPrice: 20,
    inventoryItemId: INVENTORY_ID,
    isAvailable: true,
    ...overrides,
  };
}

function inventoryItem(overrides = {}) {
  return {
    _id: INVENTORY_ID,
    name: "Injera",
    unit: "pcs",
    cost: 6.5,
    currentStock: 40,
    reservedStock: 0,
    stockGroup: STOCK_GROUP.EXTRA,
    ...overrides,
  };
}

describe("Inventory stock areas", () => {
  test("four canonical stock groups are defined with manager labels", () => {
    assert.deepEqual([...STOCK_GROUP_VALUES], ["KITCHEN", "BARISTA", "JEBENA", "EXTRA"]);
    assert.equal(STOCK_GROUP_LABELS.KITCHEN, "Kitchen Stock");
    assert.equal(STOCK_GROUP_LABELS.BARISTA, "Barista Stock");
    assert.equal(STOCK_GROUP_LABELS.JEBENA, "Jebena Buna Stock");
    assert.equal(STOCK_GROUP_LABELS.EXTRA, "Extra Items");
    assert.equal(EXTRA_ITEM_CATEGORY, "Extra Items");
  });

  test("normalization accepts known groups and never guesses an unknown one", () => {
    assert.equal(normalizeStockGroup("kitchen"), "KITCHEN");
    assert.equal(normalizeStockGroup(" Extra "), "EXTRA");
    assert.equal(normalizeStockGroup(""), null);
    assert.equal(normalizeStockGroup(null), null);
    assert.equal(normalizeStockGroup("PANTRY"), null);
    assert.equal(stockGroupLabel("jebena"), "Jebena Buna Stock");
    assert.equal(stockGroupLabel("PANTRY"), null);
  });
});

describe("Extra Item catalog eligibility", () => {
  test("an available extra with a supported linked unit is eligible", () => {
    assert.equal(isExtraItemAvailable(extra()), true);
    assert.doesNotThrow(() => assertExtraItemEligible(extra(), inventoryItem()));
  });

  test("unknown extra is rejected before any write", () => {
    assert.throws(
      () => assertExtraItemEligible(null, inventoryItem()),
      (err) => err instanceof ExtraItemError && err.status === 404 && err.code === "EXTRA_ITEM_NOT_FOUND"
    );
  });

  test("unavailable extra is rejected", () => {
    assert.equal(isExtraItemAvailable(extra({ isAvailable: false })), false);
    assert.throws(
      () => assertExtraItemEligible(extra({ isAvailable: false }), inventoryItem()),
      (err) => err.status === 403 && err.code === "EXTRA_ITEM_UNAVAILABLE"
    );
  });

  test("invalid selling price is rejected", () => {
    for (const sellingPrice of [-1, "NaN", Infinity]) {
      assert.throws(
        () => assertExtraItemEligible(extra({ sellingPrice }), inventoryItem()),
        (err) => err.status === 422 && err.code === "EXTRA_ITEM_PRICE_INVALID"
      );
    }
  });

  test("missing stock association fails closed", () => {
    assert.throws(
      () => assertExtraItemEligible(extra(), null),
      (err) => err.status === 409 && err.code === "EXTRA_ITEM_INVENTORY_NOT_FOUND"
    );
  });

  test("unsupported legacy stock units are never guessed", () => {
    for (const unit of ["plate", "cup", "box", ""]) {
      assert.throws(
        () => assertExtraItemEligible(extra(), inventoryItem({ unit })),
        (err) => err.status === 422 && err.code === "EXTRA_ITEM_UNIT_UNSUPPORTED"
      );
    }
    assert.equal(assertSupportedStockUnit("kg").unit, "g");
    assert.equal(assertSupportedStockUnit("L").unit, "ml");
    assert.equal(assertSupportedStockUnit("pcs").unit, "pcs");
  });
});

describe("Extra Item catalog projection", () => {
  test("catalog entry exposes only server-owned sellable fields", () => {
    const entry = toCatalogEntry(extra(), inventoryItem());
    assert.deepEqual(Object.keys(entry).sort(), [
      "category",
      "extraItemId",
      "inventoryItemId",
      "name",
      "nameText",
      "price",
      "unit",
    ]);
    assert.equal(entry.extraItemId, String(EXTRA_ID));
    assert.equal(entry.inventoryItemId, String(INVENTORY_ID));
    assert.equal(entry.nameText, "Extra Injera");
    assert.equal(entry.price, 20);
    assert.equal(entry.unit, "pcs");
    assert.equal("cost" in entry, false, "inventory cost is never exposed to the waiter");
    assert.equal("currentStock" in entry, false);
    assert.equal("reservedStock" in entry, false);
  });

  test("display name handles plain strings and trims selling price to 2 decimals", () => {
    const entry = toCatalogEntry(extra({ name: "Extra Cheese", sellingPrice: 12.345 }), inventoryItem({ unit: "kg" }));
    assert.equal(entry.nameText, "Extra Cheese");
    assert.equal(entry.name, "Extra Cheese");
    assert.equal(entry.price, 12.35);
    assert.equal(entry.unit, "kg");
  });
});

describe("Extra Item component building (server-authoritative)", () => {
  test("client cannot supply name, price, unit or stock quantity", () => {
    const comp = buildExtraComponent(extra(), inventoryItem(), 2, "client-forged-component");
    assert.equal(comp.kind, "PRICED_COMPONENT");
    assert.equal(comp.componentId, "client-forged-component");
    assert.equal(comp.name, "Extra Injera");
    assert.equal(comp.quantity, 2);
    assert.equal(comp.unitPrice, 20);
    assert.equal(comp.lineSum, 40);
    assert.equal(String(comp.extraItemId), String(EXTRA_ID));
    assert.equal(String(comp.inventoryItemId), String(INVENTORY_ID));
    assert.equal(comp.stockQuantity, 1, "one extra unit consumes one inventory unit");
    assert.equal(comp.stockUnit, "pcs");
    assert.equal(comp.costSnapshot, 6.5);
    assert.equal(comp.totalCost, 13);
    assert.equal(comp.note, null);
  });

  test("deduction quantity is the selected quantity in the linked item's own unit", () => {
    const comp = buildExtraComponent(extra({ sellingPrice: 15 }), inventoryItem({ unit: "kg", cost: 200 }), 3);
    assert.equal(comp.quantity, 3);
    assert.equal(comp.stockQuantity, 1);
    assert.equal(comp.stockUnit, "kg");
    assert.equal(comp.lineSum, 45);
    assert.equal(comp.costSnapshot, 200);
    assert.equal(comp.totalCost, 600);
    // Total stock deducted = stockQuantity × quantity = 3 kg.
    assert.equal(comp.stockQuantity * comp.quantity, 3);
  });

  test("quantity must be an integer 1-99", () => {
    for (const qty of [0, -1, 1.5, 100, "NaN", null]) {
      assert.throws(
        () => buildExtraComponent(extra(), inventoryItem(), qty),
        (err) => err.status === 400 && err.code === "EXTRA_ITEM_QUANTITY_INVALID"
      );
    }
  });

  test("build fails closed when the linked stock vanished or is unavailable", () => {
    assert.throws(
      () => buildExtraComponent(extra(), null, 1),
      (err) => err.code === "EXTRA_ITEM_INVENTORY_NOT_FOUND"
    );
    assert.throws(
      () => buildExtraComponent(extra({ isAvailable: false }), inventoryItem(), 1),
      (err) => err.code === "EXTRA_ITEM_UNAVAILABLE"
    );
  });

  test("batch resolver returns an empty list without a database for no extras", async () => {
    assert.deepEqual(await resolveExtraComponents(null, []), []);
    const notes = [{ kind: "NOTE", note: "no onion" }];
    assert.deepEqual(await resolveExtraComponents(null, notes), notes);
  });
});

describe("Extra Item manager payload validation", () => {
  test("create requires name, selling price and a valid stock association", () => {
    const valid = validateExtraItemPayload(
      { name: "Extra Bread", sellingPrice: 10, inventoryItemId: String(INVENTORY_ID) },
      { partial: false }
    );
    assert.equal(valid.ok, true);
    assert.equal(valid.data.category, EXTRA_ITEM_CATEGORY);
    assert.equal(valid.data.name, "Extra Bread");
    assert.equal(valid.data.sellingPrice, 10);
    assert.equal(valid.data.inventoryItemId, String(INVENTORY_ID));

    assert.ok(validateExtraItemPayload({ sellingPrice: 10, inventoryItemId: String(INVENTORY_ID) }).error.includes("name"));
    assert.ok(validateExtraItemPayload({ name: "X", inventoryItemId: String(INVENTORY_ID) }).error.includes("sellingPrice"));
    assert.ok(validateExtraItemPayload({ name: "X", sellingPrice: 10 }).error.includes("inventoryItemId"));
    assert.ok(validateExtraItemPayload({ name: "X", sellingPrice: -1, inventoryItemId: String(INVENTORY_ID) }).error.includes("sellingPrice"));
    assert.ok(validateExtraItemPayload({ name: "X", sellingPrice: 10, inventoryItemId: "nope" }).error.includes("ObjectId"));
  });

  test("no recipe fields are accepted into the persisted payload", () => {
    const res = validateExtraItemPayload(
      {
        name: "Extra Bread",
        sellingPrice: 10,
        inventoryItemId: String(INVENTORY_ID),
        recipe: { ingredients: [{ inventoryItemId: String(INVENTORY_ID), quantity: 1, unit: "pcs" }] },
        ingredients: [{ inventoryItemId: String(INVENTORY_ID), quantity: 1, unit: "pcs" }],
      },
      { partial: false }
    );
    assert.equal(res.ok, true);
    assert.equal("recipe" in res.data, false);
    assert.equal("ingredients" in res.data, false);
  });

  test("partial updates only return supplied fields and reject empty updates", () => {
    assert.deepEqual(validateExtraItemPayload({ isAvailable: false }, { partial: true }), {
      ok: true,
      data: { isAvailable: false },
    });
    assert.ok(validateExtraItemPayload({}, { partial: true }).error.includes("No update fields"));
    assert.ok(validateExtraItemPayload({ isAvailable: "yes" }, { partial: true }).error.includes("boolean"));
  });

  test("serialization exposes the stock snapshot but never inventory cost", () => {
    const out = serializeExtraItem(extra(), inventoryItem());
    assert.equal(out.name, "Extra Injera");
    assert.equal(out.sellingPrice, 20);
    assert.equal(out.isAvailable, true);
    assert.equal(out.inventory.unit, "pcs");
    assert.equal(out.inventory.currentStock, 40);
    assert.equal("cost" in out.inventory, false);
    assert.equal("cost" in out, false);
  });
});

describe("Extra stock collection helpers", () => {
  test("only server-built extra components carry stock links", () => {
    const items = [
      {
        components: [
          { kind: "NOTE", note: "no onion" },
          { kind: "PRICED_COMPONENT", extraItemId: EXTRA_ID, inventoryItemId: INVENTORY_ID },
          // Historical manual priced component without extraItemId stays readable
          // but never participates in extra fail-closed checks.
          { kind: "PRICED_COMPONENT", name: "Legacy add-on", inventoryItemId: new mongoose.Types.ObjectId() },
        ],
      },
    ];
    const ids = collectExtraStockItemIds(items);
    assert.equal(ids.size, 1);
    assert.equal(ids.has(String(INVENTORY_ID)), true);
    assert.equal(hasExtraComponents(items), true);
    assert.equal(hasExtraComponents([{ components: [{ kind: "NOTE", note: "x" }] }]), false);
  });
});

describe("Extra Item order trust boundary", () => {
  test("validate rejects standalone Extra lines", () => {
    assert.ok(validateSource.includes("Extra Items must be attached to a parent menu item"));
    assert.ok(orderService.includes("if (raw.isExtraItem === true) return null;"));
  });

  test("PRICED_COMPONENT requires extraItemId and ignores client name/price", () => {
    assert.ok(validateSource.includes("extraItemId must be valid ObjectId for PRICED_COMPONENT"));
    assert.ok(orderService.includes("const extraRaw = raw.extraItemId ?? raw.extraId;"));
    assert.ok(orderService.includes("const extraItemId = extraRaw && mongoose.isValidObjectId(String(extraRaw))"));
    assert.ok(orderService.includes("name: null,"));
    assert.ok(orderService.includes("unitPrice: null,"));
    assert.ok(orderService.includes("stockQuantity: null,"));
  });

  test("createOrder resolves extras server-side before persisting", () => {
    const create = orderService.slice(
      orderService.indexOf("export async function createOrder"),
      orderService.indexOf("function buildOrderQuery")
    );
    const resolveIdx = create.indexOf("await resolveExtraComponents(conn, componentRefs)");
    const saveIdx = create.indexOf("await doc.save({ session })");
    assert.ok(resolveIdx > 0, "extras are resolved through the service");
    assert.ok(saveIdx > resolveIdx, "resolution runs before the order write");
    assert.ok(create.includes("hasExtraComponents(items)"));
    assert.ok(create.includes("await ensureOrderInventoryReservation(conn, doc);"));
    assert.ok(create.includes("await assertExtraStockReserved(conn, doc);"));
    assert.ok(create.includes('release extra reservation after failed create'));
    assert.ok(create.includes('reason: "ORDER_CREATE_FAILED"'));
    // The fail-closed extras reservation has its own guarded save; the
    // transaction callback's save is defined earlier but executed later.
    const reserveIdx = create.indexOf("await assertExtraStockReserved(conn, doc);");
    const persistIdx = create.indexOf("runPolicyVersionTransactionOnce(conn, persistOrder)", reserveIdx);
    assert.ok(persistIdx > reserveIdx, "extras reserve and assert before the shared guarded write");
  });

  test("ordinary menu items keep their existing non-blocking post-save hook", () => {
    assert.ok(orderService.includes('runInventoryHook("reservation create", saved'));
    assert.equal(orderService.includes("isExtraItem: true,"), false);
  });
});

describe("Extra Item manager and picker endpoints", () => {
  test("catalog is authenticated, read-only and scoped to order creation", () => {
    assert.ok(catalogRoute.includes("requireAuth(request)"));
    assert.ok(catalogRoute.includes('can(auth.payload.role, "orders:create")'));
    assert.ok(catalogRoute.includes("export const GET"));
    assert.equal(catalogRoute.includes("export const POST"), false);
    assert.equal(catalogRoute.includes(".create("), false);
    assert.equal(catalogRoute.includes(".updateOne("), false);
    assert.equal(catalogRoute.includes(".delete"), false);
  });

  test("manager CRUD is MANAGER-only and inventory-cost-blind", () => {
    assert.ok(managerRoute.includes('requireAuth(request, ["MANAGER"])'));
    assert.ok(managerRoute.includes('can(auth.payload.role, "inventory:mutate")'));
    assert.ok(managerRoute.includes("export const POST"));
    assert.ok(managerItemRoute.includes('requireAuth(request, ["MANAGER"])'));
    assert.ok(managerItemRoute.includes("export const PATCH"));
    assert.ok(managerItemRoute.includes("export const DELETE"));
    assert.equal(managerRoute.includes("cost:"), false);
    assert.equal(managerItemRoute.includes("cost:"), false);
  });

  test("waiter picker is per parent and submits only extraItemId + quantity", () => {
    assert.ok(waiter.includes("/api/extra-items/catalog"));
    assert.ok(waiter.includes("openExtraPicker(cartKey)"));
    const payload = waiter.slice(
      waiter.indexOf("items: cartEntries.map"),
      waiter.indexOf("}))", waiter.indexOf("items: cartEntries.map"))
    );
    assert.ok(payload.includes('kind: "PRICED_COMPONENT"'));
    assert.ok(payload.includes("extraItemId: c.extraItemId"));
    assert.ok(payload.includes("quantity: c.quantity"));
    assert.equal(payload.includes("unitPrice: c."), false);
    assert.equal(payload.includes("name: c."), false);
    assert.equal(payload.includes("stockQuantity: c."), false);
    assert.equal(waiter.includes("isExtraItem: true"), false);
    assert.equal(waiter.includes('startsWith("ext-")'), false);
  });

  test("manager inventory UI exposes the four stock areas and Extra CRUD", () => {
    assert.ok(inventoryUi.includes("{ key: 'extras', label: 'Extra Items' }"));
    assert.ok(inventoryUi.includes("STOCK_GROUP_FILTERS"));
    assert.ok(inventoryUi.includes("stockGroupFilter"));
    assert.ok(inventoryUi.includes("/api/extra-items"));
    assert.ok(inventoryUi.includes("handleAddExtra"));
    assert.ok(inventoryUi.includes("handleEditExtra"));
    assert.ok(inventoryUi.includes("handleDeleteExtra"));
    assert.ok(inventoryUi.includes("invSellingPrice"));
    assert.ok(inventoryUi.includes("invLinkedStock"));
  });
});

describe("Extra Item history and reporting", () => {
  test("Order schema keeps extraItemId plus historical markers", () => {
    assert.ok(orderModel.includes("extraItemId: { type: mongoose.Schema.Types.ObjectId, ref: \"ExtraItem\""));
    assert.ok(orderModel.includes("isExternal: { type: Boolean, default: false }"));
    assert.ok(orderModel.includes("retained for historical read compatibility"));
    assert.ok(orderModel.includes("New orders always write false"));
    assert.ok(orderModel.includes("isExtraItem: { type: Boolean, default: false }"));
  });

  test("KDS projection carries the component extraItemId", () => {
    assert.ok(orderService.includes("extraItemId: c.extraItemId ? String(c.extraItemId) : null"));
    assert.ok(orderService.includes("isExtraItem: !!i.isExtraItem"));
  });

  test("reporting never invents a separate Extra revenue bucket", () => {
    const reportService = src("lib/reportService.js");
    const reportRevenue = src("lib/reportRevenueBreakdown.js");
    assert.equal(reportService.includes("externalSales"), false);
    assert.equal(reportRevenue.includes("externalSales"), false);
    assert.equal(reportRevenue.includes("isExternal"), false);
  });
});

describe("obsolete external functionality stays removed", () => {
  test("external routes and model are absent", () => {
    assert.equal(exists("app/api/external-items/route.js"), false);
    assert.equal(exists("app/api/external-sales/route.js"), false);
    assert.equal(exists("lib/models/ExternalItemRequest.js"), false);
  });

  test("no active external/approval policy permissions remain", () => {
    const policy = src("lib/policy.js");
    assert.equal(policy.includes("orders:external"), false);
    assert.equal(policy.includes("inventory:approve"), false);
  });
});
