// C1 — catalog identity is mandatory for every new ordinary order line.
//
// DB-FREE ONLY. No MongoDB connection is opened and no environment file is
// read. createOrder is exercised through an in-memory connection stub so the
// whole pre-write path (validation, catalog lookup, authoritative snapshot,
// atomic rejection) is covered instead of asserting source text.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { validateCreateOrderPayload } from "../lib/validate.js";
import { addPolicyVersionSupport } from "./helpers/policy-version-fakes.mjs";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));
const { createOrder, toKdsShape } = await import("../lib/orderService.js");

const FOOD_ID = "507f1f77bcf86cd7994390a1";
const DRINK_ID = "507f1f77bcf86cd7994390a2";
const MISSING_ID = "507f1f77bcf86cd7994390a3";

const FOOD_CATALOG = {
  _id: FOOD_ID,
  name: { am: "በርገር", en: "Catalog Burger", om: "Burgar" },
  price: 250,
  categoryType: "FOOD",
  station: "KITCHEN",
  targetStation: "KITCHEN",
  isAvailable: true,
  // H1: every new-order fixture states an explicit policy.
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
  inventoryPolicy: "UNTRACKED",
};

// Minimal Mongoose-compatible connection: only the models createOrder touches
// before the order write. No network, no real Order document is constructed.
function makeConn({ menuItems = [], failCatalog = false } = {}) {
  const saved = [];
  const MenuItem = {
    find(filter) {
      if (failCatalog) throw new Error("catalog unavailable");
      const ids = (filter?._id?.$in || []).map(String);
      const found = menuItems.filter((m) => ids.includes(String(m._id)));
      return { lean: async () => found };
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
      OrderCounter: { findOneAndUpdate: async () => ({ seq: saved.length + 1 }) },
    },
  };
  addPolicyVersionSupport(conn);
  return { conn, saved };
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

function payload(items, overrides = {}) {
  return { tableNumber: 7, items, ...overrides };
}

describe("C1 — mandatory catalog identity at the payload boundary", () => {
  test("missing itemId is rejected", () => {
    const res = validateCreateOrderPayload(payload([line({ itemId: undefined })]));
    assert.equal(res.ok, undefined);
    assert.match(res.error, /itemId is required/);
  });

  test("null itemId is rejected", () => {
    const res = validateCreateOrderPayload(payload([line({ itemId: null })]));
    assert.equal(res.ok, undefined);
    assert.match(res.error, /itemId is required/);
  });

  test("malformed itemId is rejected", () => {
    const res = validateCreateOrderPayload(payload([line({ itemId: "not-an-object-id" })]));
    assert.equal(res.ok, undefined);
    assert.match(res.error, /itemId must be a valid ObjectId/);
  });
});

describe("C1 — createOrder resolves every catalog id and fails atomically", () => {
  test("valid-format but nonexistent ObjectId rejects the order; nothing persisted", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    await assert.rejects(
      () => createOrder(conn, payload([line({ itemId: MISSING_ID })])),
      /not found in the catalog/
    );
    assert.equal(saved.length, 0);
  });

  test("deleted/non-resolving MenuItem reference rejects the order; nothing persisted", async () => {
    // The catalog returns no record for the previously known id (deleted item).
    const { conn, saved } = makeConn({ menuItems: [] });
    await assert.rejects(
      () => createOrder(conn, payload([line({ itemId: FOOD_ID })])),
      /not found in the catalog/
    );
    assert.equal(saved.length, 0);
  });

  test("missing itemId is rejected by the service even if the payload boundary is bypassed", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    await assert.rejects(
      () => createOrder(conn, payload([line({ itemId: undefined })])),
      /itemId is required/
    );
    assert.equal(saved.length, 0);
  });

  test("null itemId is rejected by the service even if the payload boundary is bypassed", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    await assert.rejects(
      () => createOrder(conn, payload([line({ itemId: null })])),
      /itemId is required/
    );
    assert.equal(saved.length, 0);
  });

  test("malformed itemId is rejected by the service even if the payload boundary is bypassed", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    await assert.rejects(
      () => createOrder(conn, payload([line({ itemId: "not-an-object-id" })])),
      /itemId is required/
    );
    assert.equal(saved.length, 0);
  });
});

describe("C1 — server owns catalog-derived name, price and station", () => {
  test("forged client price is replaced by the catalog price", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    const doc = await createOrder(conn, payload([line({ price: 0.01, quantity: 2 })]));
    assert.equal(saved.length, 1);
    assert.equal(doc.items[0].price, 250);
    assert.equal(doc.totalAmount, 500);
  });

  test("forged client name is replaced by the catalog name", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    const doc = await createOrder(conn, payload([line({ name: "Forged client name" })]));
    assert.equal(saved.length, 1);
    // getLocalizedSingleString prefers the first populated catalog locale (am).
    assert.equal(doc.items[0].name, FOOD_CATALOG.name.am);
    assert.notEqual(doc.items[0].name, "Forged client name");
  });

  test("forged client type cannot route the item to another station", async () => {
    const { conn, saved } = makeConn({ menuItems: [DRINK_CATALOG] });
    const doc = await createOrder(
      conn,
      payload([line({ itemId: DRINK_ID, type: "FOOD", category: "HOT_DRINK", barista: false })])
    );
    assert.equal(saved.length, 1);
    assert.equal(doc.items[0].type, "DRINK");
    assert.equal(doc.baristaStatus, "PENDING");
    assert.equal(doc.kitchenStatus, null);
    assert.equal(doc.hotDrinkStatus, null);
  });
});

describe("C1 — invalid lines reject the whole order (no partial order)", () => {
  test("mixed valid and nonexistent catalog lines persist nothing", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    await assert.rejects(
      () =>
        createOrder(
          conn,
          payload([line({ itemId: FOOD_ID }), line({ itemId: MISSING_ID, quantity: 2 })])
        ),
      /not found in the catalog/
    );
    assert.equal(saved.length, 0);
  });

  test("mixed valid and itemId-less lines are rejected at the boundary and persist nothing", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    const body = payload([line({ itemId: FOOD_ID }), line({ itemId: undefined, quantity: 2 })]);
    const res = validateCreateOrderPayload(body);
    assert.equal(res.ok, undefined);
    assert.match(res.error, /itemId is required/);
    await assert.rejects(() => createOrder(conn, body), /itemId is required/);
    assert.equal(saved.length, 0);
  });

  test("a malformed shape in one line never silently drops it and saves the rest", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    // quantity 0 makes normalizeItem return null; the old code filtered it out
    // and persisted the first line as a partial order.
    await assert.rejects(
      () => createOrder(conn, payload([line({ itemId: FOOD_ID }), line({ quantity: 0 })])),
      /invalid item line/
    );
    assert.equal(saved.length, 0);
  });
});

describe("C1 — valid catalog-backed orders and existing flows still work", () => {
  test("a valid catalog-backed order still succeeds with the server snapshot", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    const waiterId = new mongoose.Types.ObjectId().toString();
    const doc = await createOrder(
      conn,
      payload([line({ quantity: 2 })], {
        waiterId,
        waiterName: "Abel",
        waiterNumber: 3,
        paymentMethod: "CASH",
      })
    );
    assert.equal(saved.length, 1);
    assert.equal(String(doc.items[0].itemId), FOOD_ID);
    assert.equal(doc.items[0].name, FOOD_CATALOG.name.am);
    assert.equal(doc.items[0].price, 250);
    assert.equal(doc.items[0].quantity, 2);
    assert.equal(doc.items[0].type, "FOOD");
    assert.ok(doc.items[0].lineId);
    assert.equal(doc.totalAmount, 500);
    assert.equal(String(doc.waiterId), waiterId);
    assert.equal(doc.waiterName, "Abel");
    assert.equal(doc.paymentMethod, "CASH");
    assert.equal(doc.kitchenStatus, "PENDING");
  });

  test("NOTE components remain attached to a catalog-backed parent", async () => {
    const { conn, saved } = makeConn({ menuItems: [FOOD_CATALOG] });
    const doc = await createOrder(
      conn,
      payload([line({ components: [{ kind: "NOTE", note: "no onion" }] })])
    );
    assert.equal(saved.length, 1);
    assert.equal(doc.items[0].components.length, 1);
    assert.equal(doc.items[0].components[0].kind, "NOTE");
    assert.equal(doc.items[0].components[0].note, "no onion");
  });

  test("EXTRA/component identity rules are unchanged (extraItemId only, catalog parent required)", () => {
    const extraItemId = new mongoose.Types.ObjectId().toString();
    const accepted = validateCreateOrderPayload(
      payload([
        line({
          components: [
            { kind: "PRICED_COMPONENT", extraItemId, quantity: 2, name: "forged", unitPrice: 9999 },
          ],
        }),
      ])
    );
    assert.equal(accepted.ok, true);
    assert.deepEqual(Object.keys(accepted.data.items[0].components[0]).sort(), [
      "extraItemId",
      "kind",
      "quantity",
    ]);
    assert.equal(accepted.data.items[0].components[0].extraItemId, extraItemId);

    const freeTextParent = validateCreateOrderPayload(
      payload([
        line({
          itemId: undefined,
          components: [{ kind: "PRICED_COMPONENT", extraItemId, quantity: 1 }],
        }),
      ])
    );
    assert.equal(freeTextParent.ok, undefined);
    assert.match(freeTextParent.error, /PRICED_COMPONENT requires a parent menu item/);

    const standaloneExtra = validateCreateOrderPayload(
      payload([line({ isExtraItem: true })])
    );
    assert.equal(standaloneExtra.ok, undefined);
    assert.match(standaloneExtra.error, /must be attached to a parent menu item/);
  });

  test("historical orders without itemId/components still project for reads", () => {
    const legacy = {
      _id: new mongoose.Types.ObjectId(),
      orderNumber: "ORD-LEGACY-1",
      tableNumber: 2,
      waiterName: "Legacy Waiter",
      waiterNumber: 1,
      status: "PAID",
      totalAmount: 160,
      items: [
        {
          name: { am: "ሽሮ", en: "Shiro", om: "Shiroo" },
          price: 120,
          quantity: 1,
          type: "FOOD",
          // legacy free-text priced component without the new extra identity
          components: [{ kind: "PRICED_COMPONENT", name: "Cheese", quantity: 1, unitPrice: 40, lineSum: 40 }],
        },
      ],
    };
    const shaped = toKdsShape(legacy);
    assert.equal(shaped.items[0].name, legacy.items[0].name.am);
    assert.equal(shaped.items[0].itemId, null);
    assert.equal(shaped.items[0].components.length, 1);
    assert.equal(shaped.items[0].components[0].extraItemId, null);
    assert.equal(shaped.items[0].components[0].lineSum, 40);
    assert.equal(shaped.netAmount, 160);
    assert.equal(shaped.status, "PAID");
  });
});
