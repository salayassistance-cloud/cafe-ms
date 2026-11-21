#!/usr/bin/env node
// DB-free checks for the parent-attached Extra Item contract.
// No DB, no Atlas, no secrets, no network.
import fs from "node:fs";
import mongoose from "mongoose";
import {
  isExtraItemAvailable,
  assertExtraItemEligible,
  toCatalogEntry,
  buildExtraComponent,
  validateExtraItemPayload,
  collectExtraStockItemIds,
} from "../lib/extraItemService.js";
import {
  STOCK_GROUP,
  STOCK_GROUP_VALUES,
  EXTRA_ITEM_CATEGORY,
  normalizeStockGroup,
} from "../lib/inventoryCategories.js";

let pass = 0;
let fail = 0;
function ok(name, cond, note = "") {
  if (cond) {
    console.log(`✅ ${name}`);
    pass++;
  } else {
    console.log(`❌ ${name} ${note}`);
    fail++;
  }
}
function throwsCode(fn, code) {
  try {
    fn();
    return false;
  } catch (err) {
    return err?.code === code;
  }
}

const wait = fs.readFileSync("app/components/WaiterUI.js", "utf8");
const orderService = fs.readFileSync("lib/orderService.js", "utf8");
const orderModel = fs.readFileSync("lib/models/Order.js", "utf8");
const validateSource = fs.readFileSync("lib/validate.js", "utf8");
const catalogRoute = fs.readFileSync("app/api/extra-items/catalog/route.js", "utf8");
const managerRoute = fs.readFileSync("app/api/extra-items/route.js", "utf8");
const managerItemRoute = fs.readFileSync("app/api/extra-items/[id]/route.js", "utf8");
const inventoryUi = fs.readFileSync("app/components/InventoryUI.jsx", "utf8");

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

// 1. Client contract — parent-attached extras, extraItemId + quantity only.
ok("1a WaiterUI loads the server Extra catalog", wait.includes("/api/extra-items/catalog"));
ok("1b WaiterUI opens the picker per parent cart line", wait.includes("openExtraPicker(cartKey)"));
ok("1c WaiterUI has no standalone isExtraItem lines", !wait.includes("isExtraItem: true"));
ok("1d WaiterUI has no ext- free-text identity", !wait.includes('startsWith("ext-")'));
ok(
  "1e submit payload sends only extraItemId + quantity",
  wait.includes("extraItemId: c.extraItemId") &&
    wait.includes("quantity: c.quantity") &&
    !wait.includes("unitPrice: c.") &&
    !wait.includes("stockQuantity: c.")
);

// 2. Server normalization — no standalone extras, no free-text priced add-ons.
ok(
  "2a validate rejects standalone Extra lines",
  validateSource.includes("Extra Items must be attached to a parent menu item")
);
ok(
  "2b orderService drops standalone Extra lines",
  orderService.includes("if (raw.isExtraItem === true) return null;")
);
ok(
  "2c PRICED_COMPONENT requires extraItemId",
  validateSource.includes("extraItemId must be valid ObjectId for PRICED_COMPONENT")
);
ok(
  "2d createOrder resolves extras before writing",
  orderService.includes("await resolveExtraComponents(conn, componentRefs)") &&
    orderService.includes("hasExtraComponents(items)")
);
ok(
  "2e Extra shortage fails closed before order save",
  orderService.includes("await ensureOrderInventoryReservation(conn, doc);") &&
    orderService.includes("await assertExtraStockReserved(conn, doc);") &&
    orderService.includes("release extra reservation after failed create")
);
ok(
  "2f New orders never write isExtraItem true",
  !orderService.includes("isExtraItem: true,")
);
ok(
  "2g Order schema keeps extraItemId and historical markers",
  orderModel.includes('extraItemId: { type: mongoose.Schema.Types.ObjectId, ref: "ExtraItem"') &&
    orderModel.includes("isExtraItem: { type: Boolean, default: false }")
);

// 3. Eligibility rules (pure).
ok("3a available extra with supported unit is eligible", (() => {
  try {
    assertExtraItemEligible(extra(), inventoryItem());
    return true;
  } catch {
    return false;
  }
})());
ok(
  "3b unavailable extra is rejected",
  throwsCode(() => assertExtraItemEligible(extra({ isAvailable: false }), inventoryItem()), "EXTRA_ITEM_UNAVAILABLE")
);
ok(
  "3c missing extra is rejected",
  throwsCode(() => assertExtraItemEligible(null, inventoryItem()), "EXTRA_ITEM_NOT_FOUND")
);
ok(
  "3d missing stock association is rejected",
  throwsCode(() => assertExtraItemEligible(extra(), null), "EXTRA_ITEM_INVENTORY_NOT_FOUND")
);
ok(
  "3e unsupported stock unit is rejected",
  throwsCode(() => assertExtraItemEligible(extra(), inventoryItem({ unit: "plate" })), "EXTRA_ITEM_UNIT_UNSUPPORTED")
);
ok(
  "3f bad selling price is rejected",
  throwsCode(() => assertExtraItemEligible(extra({ sellingPrice: -1 }), inventoryItem()), "EXTRA_ITEM_PRICE_INVALID")
);
ok("3g availability helper respects isAvailable", isExtraItemAvailable(extra()) && !isExtraItemAvailable(extra({ isAvailable: false })));

// 4. Catalog projection — sellable fields only.
ok(
  "4a catalog entry carries no cost or stock levels",
  (() => {
    const entry = toCatalogEntry(extra(), inventoryItem());
    return (
      entry.extraItemId === String(EXTRA_ID) &&
      entry.price === 20 &&
      entry.unit === "pcs" &&
      entry.nameText === "Extra Injera" &&
      !("cost" in entry) &&
      !("currentStock" in entry)
    );
  })()
);

// 5. Component building — one stock unit per selected extra.
ok(
  "5a server builds name/price/unit/stock from the extra and linked item",
  (() => {
    const comp = buildExtraComponent(extra(), inventoryItem(), 2);
    return (
      comp.kind === "PRICED_COMPONENT" &&
      comp.name === "Extra Injera" &&
      comp.unitPrice === 20 &&
      comp.lineSum === 40 &&
      comp.stockQuantity === 1 &&
      comp.stockUnit === "pcs" &&
      comp.totalCost === 13 &&
      String(comp.extraItemId) === String(EXTRA_ID) &&
      String(comp.inventoryItemId) === String(INVENTORY_ID)
    );
  })()
);
ok(
  "5b quantity outside 1-99 is rejected",
  throwsCode(() => buildExtraComponent(extra(), inventoryItem(), 0), "EXTRA_ITEM_QUANTITY_INVALID") &&
    throwsCode(() => buildExtraComponent(extra(), inventoryItem(), 100), "EXTRA_ITEM_QUANTITY_INVALID")
);
ok(
  "5c manager payload requires name/price/stock id",
  (() => {
    const valid = validateExtraItemPayload(
      { name: "Extra Bread", sellingPrice: 10, inventoryItemId: String(INVENTORY_ID) },
      { partial: false }
    );
    return valid.ok && valid.data.category === EXTRA_ITEM_CATEGORY;
  })()
);
ok(
  "5d manager payload rejects recipe fields silently",
  (() => {
    const res = validateExtraItemPayload(
      {
        name: "Extra Bread",
        sellingPrice: 10,
        inventoryItemId: String(INVENTORY_ID),
        recipe: { ingredients: [] },
      },
      { partial: false }
    );
    return res.ok && !("recipe" in res.data);
  })()
);
ok(
  "5e only extra-linked components participate in stock checks",
  (() => {
    const ids = collectExtraStockItemIds([
      { components: [
        { kind: "PRICED_COMPONENT", extraItemId: EXTRA_ID, inventoryItemId: INVENTORY_ID },
        { kind: "PRICED_COMPONENT", name: "Legacy", inventoryItemId: new mongoose.Types.ObjectId() },
      ] },
    ]);
    return ids.size === 1 && ids.has(String(INVENTORY_ID));
  })()
);

// 6. Endpoints — picker read-only, manager CRUD protected.
ok("6a catalog route requires authentication", catalogRoute.includes("requireAuth(request)"));
ok("6b catalog route requires orders:create", catalogRoute.includes('can(auth.payload.role, "orders:create")'));
ok("6c catalog route is GET-only", catalogRoute.includes("export const GET") && !catalogRoute.includes("export const POST"));
ok("6d manager list/create requires MANAGER", managerRoute.includes('requireAuth(request, ["MANAGER"])') && managerRoute.includes("export const POST"));
ok("6e manager update/delete requires MANAGER", managerItemRoute.includes('requireAuth(request, ["MANAGER"])') && managerItemRoute.includes("export const PATCH") && managerItemRoute.includes("export const DELETE"));

// 7. Four stock areas — no automatic backfill/guessing.
ok("7a four stock groups are defined", STOCK_GROUP_VALUES.length === 4 && STOCK_GROUP.EXTRA === "EXTRA");
ok("7b unknown stock group normalizes to null", normalizeStockGroup("PANTRY") === null);
ok("7c Inventory UI exposes four stock areas", inventoryUi.includes("STOCK_GROUP_FILTERS") && inventoryUi.includes("stockGroupFilter"));
ok("7d Inventory UI has Extra Items manager tab", inventoryUi.includes("{ key: 'extras', label: 'Extra Items' }") && inventoryUi.includes("/api/extra-items"));

// 8. Obsolete external flows are gone.
ok("8a external-items route removed", !fs.existsSync("app/api/external-items/route.js"));
ok("8b external-sales route removed", !fs.existsSync("app/api/external-sales/route.js"));
ok("8c ExternalItemRequest model removed", !fs.existsSync("lib/models/ExternalItemRequest.js"));

// 9. Arithmetic sanity.
ok("9a Extra Injera 20 x2 = 40", (() => {
  const price = 20;
  const qty = 2;
  return Math.round(price * qty * 100) / 100 === 40;
})());

console.log(`\n--- SUMMARY pass ${pass} fail ${fail} ---`);
if (fail > 0) process.exit(1);
console.log("Extra Item DB-free checks passed — not proof of live inventory/reporting");
