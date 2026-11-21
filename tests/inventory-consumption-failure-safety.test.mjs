// OBS-6 P1 S3 — DB-free regression for the payment-failure release barrier.
//
// The order is already PAID when post-commit consumption fails. A release on
// this path must never void or reclassify SaleDeduction movements as Waste,
// because an unknown commit or a failed probe may mean stock was consumed.
// These tests exercise the real releaseOrderInventory helper with a fake
// connection and prove:
//   * recordVoid:false preserves consumed evidence with zero writes;
//   * the default post-preparation void path is unchanged;
//   * recordVoid:false still releases a genuine (unconsumed) hold.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const { releaseOrderInventory } = await import("../lib/inventoryReservationService.js");

const ORDER_ID = "507f1f77bcf86cd799439011";
const RESERVATION_ID = "507f1f77bcf86cd799439014";
const ITEM_ID = "507f1f77bcf86cd799439015";

function reservationFixture(overrides = {}) {
  return {
    _id: RESERVATION_ID,
    orderId: ORDER_ID,
    status: "CONSUMED",
    consumedAt: new Date("2026-11-18T10:00:00.000Z"),
    items: [
      {
        inventoryItemId: ITEM_ID,
        unit: "g",
        requiredQuantity: 10,
        reservedQuantity: 0,
        consumedQuantity: 10,
      },
    ],
    voids: [],
    ...overrides,
  };
}

function harness(reservation, { updated = null } = {}) {
  const itemWrites = [];
  const reservationWrites = [];
  const movementWrites = [];
  const sessions = [];

  const Reservation = {
    findOne() {
      const query = { session: () => query, lean: async () => reservation };
      return query;
    },
    findOneAndUpdate(filter, update, options) {
      reservationWrites.push({ filter, update, options });
      const doc = updated || reservation;
      return { lean: async () => doc };
    },
  };

  const InventoryItem = {
    updateOne(filter, update, options) {
      itemWrites.push({ filter, update, options });
      return { modifiedCount: 1 };
    },
  };

  const StockMovement = {
    updateMany(filter, update, options) {
      movementWrites.push({ filter, update, options });
      return { modifiedCount: 1 };
    },
  };

  const session = {
    startTransaction() {},
    async commitTransaction() {},
    async abortTransaction() {},
    async endSession() {},
  };

  const conn = {
    models: { InventoryReservation: Reservation, InventoryItem, StockMovement },
    startSession: async () => {
      sessions.push(session);
      return session;
    },
  };

  return { conn, itemWrites, reservationWrites, movementWrites, sessions };
}

describe("OBS-6 P1 S3: payment-failure release cannot void consumed stock", () => {
  test("CONSUMPTION_FAILED with recordVoid:false preserves consumed evidence", async () => {
    const reservation = reservationFixture();
    const h = harness(reservation);

    const result = await releaseOrderInventory(h.conn, { _id: ORDER_ID }, {
      reason: "CONSUMPTION_FAILED",
      recordVoid: false,
    });

    assert.equal(result, reservation, "the committed reservation is returned unchanged");
    assert.equal(h.reservationWrites.length, 0, "no void or status write");
    assert.equal(h.itemWrites.length, 0, "no stock movement");
    assert.equal(h.movementWrites.length, 0, "no sale movement is reclassified as Waste");
    assert.equal(h.sessions.length, 1, "exactly one transaction is attempted");
  });

  test("the default post-preparation void still reclassifies sale movements", async () => {
    const reservation = reservationFixture();
    const voided = reservationFixture({
      voidedAt: new Date("2026-11-18T11:00:00.000Z"),
      voidReason: "CANCELLED",
      voids: [{ source: "ORDER" }],
    });
    const h = harness(reservation, { updated: voided });

    const result = await releaseOrderInventory(h.conn, { _id: ORDER_ID }, {
      reason: "CANCELLED",
    });

    assert.equal(result, voided);
    assert.equal(h.itemWrites.length, 0, "consumed stock is never returned");
    assert.equal(h.reservationWrites.length, 1);
    const write = h.reservationWrites[0];
    assert.equal(write.update.$push.voids.source, "ORDER");
    assert.equal(write.update.$push.voids.phase, "AFTER_PREPARATION");
    assert.equal(write.update.$set.voidReason, "CANCELLED");

    assert.equal(h.movementWrites.length, 1);
    assert.deepEqual(h.movementWrites[0].filter, {
      refOrderId: ORDER_ID,
      reason: "SaleDeduction",
    });
    assert.equal(h.movementWrites[0].update.$set.reason, "Waste");
  });

  test("recordVoid:false still releases a genuine unconsumed hold", async () => {
    const reservation = reservationFixture({
      status: "RESERVED",
      consumedAt: null,
      items: [
        {
          inventoryItemId: ITEM_ID,
          unit: "g",
          requiredQuantity: 10,
          reservedQuantity: 10,
          consumedQuantity: 0,
        },
      ],
    });
    const released = { ...reservation, status: "RELEASED", reservedQuantity: 0 };
    const h = harness(reservation, { updated: released });

    const result = await releaseOrderInventory(h.conn, { _id: ORDER_ID }, {
      reason: "CONSUMPTION_FAILED",
      recordVoid: false,
    });

    assert.equal(result, released);
    assert.equal(h.itemWrites.length, 1, "the held quantity is returned");
    assert.deepEqual(h.itemWrites[0].update[0].$set.reservedStock.$max[0], 0);
    assert.equal(h.reservationWrites.length, 1);
    assert.equal(h.reservationWrites[0].update.$push, undefined, "no void is appended");
    assert.equal(h.movementWrites.length, 0, "no movement is reclassified");
  });
});
