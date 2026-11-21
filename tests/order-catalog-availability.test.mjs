// H3 + M1 — menu availability enforcement and fail-closed catalog reads.
//
// DB-FREE ONLY. No MongoDB connection is opened and no environment file is
// read. createOrder/editOrderItems run against in-memory model stubs so the
// pre-write path (catalog query, availability gate, no partial write, no
// inventory hold) is exercised for real instead of only matching source text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { addPolicyVersionSupport } from "./helpers/policy-version-fakes.mjs";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));
const { createOrder, editOrderItems, isMenuItemUnavailable } = await import(
  "../lib/orderService.js"
);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const FOOD_ID = "507f1f77bcf86cd7994390b1";
const DRINK_ID = "507f1f77bcf86cd7994390b2";
const MISSING_ID = "507f1f77bcf86cd7994390b3";

const FOOD_CATALOG = {
  _id: FOOD_ID,
  name: { am: "በርገር", en: "Catalog Burger", om: "Burgar" },
  price: 250,
  categoryType: "FOOD",
  station: "KITCHEN",
  targetStation: "KITCHEN",
  isAvailable: true,
  inStock: true,
  // H1: explicit policy keeps the availability tests focused on availability.
  inventoryPolicy: "UNTRACKED",
};

const DRINK_CATALOG = {
  _id: DRINK_ID,
  name: { am: "ቡና", en: "Catalog Coffee", om: "Buna" },
  price: 40,
  categoryType: "DRINK",
  station: "BARISTA",
  targetStation: "BARISTA",
  isAvailable: true,
  inStock: true,
  inventoryPolicy: "UNTRACKED",
};

function makeConn({ menuItems = [], failCatalog = false } = {}) {
  const saved = [];
  const reservationCalls = [];
  const MenuItem = {
    find(filter) {
      if (failCatalog) {
        throw new Error("server selection timed out; secret=do-not-leak");
      }
      const ids = (filter?._id?.$in || []).map(String);
      const found = menuItems.filter((m) => ids.includes(String(m._id)));
      return { lean: async () => found };
    },
  };

  const InventoryReservation = {
    findOne() {
      reservationCalls.push("findOne");
      return {
        lean: async () => null,
        session() {
          return this;
        },
      };
    },
    create(docs) {
      reservationCalls.push("create");
      return docs;
    },
  };

  class FakeOrder {
    constructor(data) {
      Object.assign(this, data);
      this._id = new mongoose.Types.ObjectId();
    }
    async save() {
      saved.push(this);
      return this;
    }
  }

  const conn = {
    models: {
      Order: FakeOrder,
      MenuItem,
      InventoryReservation,
      OrderCounter: { findOneAndUpdate: async () => ({ seq: saved.length + 1 }) },
    },
  };
  addPolicyVersionSupport(conn);
  return { conn, saved, reservationCalls };
}

function line(overrides = {}) {
  return {
    itemId: FOOD_ID,
    name: "Forged client name",
    price: 1,
    quantity: 1,
    type: "FOOD",
    ...overrides,
  };
}

function payload(items) {
  return { tableNumber: 9, items };
}

function expectCatalogError(err, { status, code }) {
  assert.equal(err?.name, "OrderCatalogError");
  assert.equal(err?.status, status);
  assert.equal(err?.code, code);
  return true;
}

describe("H3 — new orders reject explicitly unavailable catalog items", () => {
  test("isAvailable: false rejects the order before any write", async () => {
    const { conn, saved, reservationCalls } = makeConn({
      menuItems: [{ ...FOOD_CATALOG, isAvailable: false }],
    });
    await assert.rejects(
      () => createOrder(conn, payload([line()])),
      (err) => expectCatalogError(err, { status: 400, code: "MENU_ITEM_UNAVAILABLE" })
    );
    assert.equal(saved.length, 0);
    assert.equal(reservationCalls.length, 0);
  });

  test("inStock: false rejects the order before any write", async () => {
    const { conn, saved, reservationCalls } = makeConn({
      menuItems: [{ ...FOOD_CATALOG, inStock: false }],
    });
    await assert.rejects(
      () => createOrder(conn, payload([line()])),
      (err) => expectCatalogError(err, { status: 400, code: "MENU_ITEM_UNAVAILABLE" })
    );
    assert.equal(saved.length, 0);
    assert.equal(reservationCalls.length, 0);
  });

  test("one unavailable line in a mixed order rejects everything (no partial order)", async () => {
    const { conn, saved, reservationCalls } = makeConn({
      menuItems: [FOOD_CATALOG, { ...DRINK_CATALOG, isAvailable: false }],
    });
    await assert.rejects(
      () =>
        createOrder(
          conn,
          payload([line({ itemId: FOOD_ID }), line({ itemId: DRINK_ID, quantity: 2 })])
        ),
      (err) => expectCatalogError(err, { status: 400, code: "MENU_ITEM_UNAVAILABLE" })
    );
    assert.equal(saved.length, 0);
    assert.equal(reservationCalls.length, 0);
  });

  test("both availability flags explicitly true accepts the order", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    const doc = await createOrder(conn, payload([line({ quantity: 2 })]));
    assert.equal(saved.length, 1);
    assert.equal(doc.items[0].price, 250);
    assert.equal(doc.totalAmount, 500);
  });

  test("missing optional flags follow the edit path semantics (not unavailable)", async () => {
    const { isAvailable, inStock, ...legacyCatalog } = FOOD_CATALOG;
    assert.equal(isMenuItemUnavailable(legacyCatalog), false);
    const { conn, saved } = makeConn({ menuItems: [legacyCatalog] });
    const doc = await createOrder(conn, payload([line()]));
    assert.equal(saved.length, 1);
    assert.equal(String(doc.items[0].itemId), FOOD_ID);
  });

  test("client-forged availability flags cannot override the catalog", async () => {
    const { conn, saved } = makeConn({
      menuItems: [{ ...FOOD_CATALOG, isAvailable: false, inStock: false }],
    });
    await assert.rejects(
      () =>
        createOrder(
          conn,
          payload([line({ isAvailable: true, inStock: true, available: true })])
        ),
      (err) => expectCatalogError(err, { status: 400, code: "MENU_ITEM_UNAVAILABLE" })
    );
    assert.equal(saved.length, 0);
  });

  test("existing editOrderItems unavailable-item behavior is unchanged", async () => {
    const unavailable = { ...FOOD_CATALOG, isAvailable: false };
    const waiterId = new mongoose.Types.ObjectId();
    const existing = {
      _id: new mongoose.Types.ObjectId(),
      status: "PENDING",
      waiterId,
      items: [],
    };
    let wrote = false;
    const conn = {
      models: {
        Order: {
          findOne: () => ({ lean: async () => existing }),
          findOneAndUpdate: () => {
            wrote = true;
            throw new Error("must not write");
          },
        },
        MenuItem: { find: () => ({ lean: async () => [unavailable] }) },
      },
    };
    await assert.rejects(
      () =>
        editOrderItems(
          conn,
          existing._id,
          [{ op: "add", menuItemId: FOOD_ID, quantity: 1 }],
          { staffRole: "MANAGER", staffId: waiterId.toString() }
        ),
      /Cannot add unavailable menu item/
    );
    assert.equal(wrote, false);
  });
});

describe("M1 — catalog read failures fail closed", () => {
  test("a thrown catalog query becomes a controlled 503 without leaking details", async () => {
    const { conn } = makeConn({ failCatalog: true });
    await assert.rejects(
      () => createOrder(conn, payload([line()])),
      (err) => {
        expectCatalogError(err, { status: 503, code: "CATALOG_UNAVAILABLE" });
        assert.doesNotMatch(err.message, /secret|server selection|timed out/i);
        return true;
      }
    );
  });

  test("catalog failure persists no order and creates no inventory reservation", async () => {
    const { conn, saved, reservationCalls } = makeConn({ failCatalog: true });
    await assert.rejects(() => createOrder(conn, payload([line()])));
    assert.equal(saved.length, 0);
    assert.equal(reservationCalls.length, 0);
  });

  test("a successful query with an unknown id is a distinct 4xx, not 503", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    await assert.rejects(
      () => createOrder(conn, payload([line({ itemId: MISSING_ID })])),
      (err) => expectCatalogError(err, { status: 400, code: "CATALOG_ITEM_NOT_FOUND" })
    );
    assert.equal(saved.length, 0);
  });

  test("a valid item keeps catalog-derived price/name/type", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    const doc = await createOrder(
      conn,
      payload([line({ name: "forged", price: 0.01, type: "HOT_DRINK" })])
    );
    assert.equal(saved.length, 1);
    assert.equal(doc.items[0].name, FOOD_CATALOG.name.am);
    assert.equal(doc.items[0].price, 250);
    assert.equal(doc.items[0].type, "FOOD");
  });

  test("EXTRA/component flow remains unchanged for an available catalog parent", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    const doc = await createOrder(
      conn,
      payload([line({ components: [{ kind: "NOTE", note: "no onion" }] })])
    );
    assert.equal(saved.length, 1);
    assert.equal(doc.items[0].components.length, 1);
    assert.equal(doc.items[0].components[0].kind, "NOTE");
  });

  test("the orders POST route maps typed catalog status/code to the HTTP envelope", () => {
    const routeSource = readFileSync(join(root, "app/api/orders/route.js"), "utf8");
    assert.match(
      routeSource,
      /Number\.isInteger\(e\?\.status\)[\s\S]{0,200}fail\(msg, e\.status, e\.code\)/,
      "typed 503/4xx catalog errors must not degrade to a generic 500"
    );
  });
});
