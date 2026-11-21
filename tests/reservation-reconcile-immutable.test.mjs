// OBS-1 regression — DB-free.
//
// Reconciliation recomputes requirements and rewrites the reservation. A
// reservation that is in flight (CONSUMING) or terminal (CONSUMED, RELEASED)
// belongs to the consumption/void path and must never be rewritten. The read
// guards alone are not enough: consumption can claim CONSUMING between the
// snapshot read and the write, so the atomic predicate must carry the same
// immutable list. These tests exercise the real production helper and the real
// reconcileOrderInventory result-handling path with a fake connection.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";

register(new URL("./helpers/pos-phase25-loader.mjs", import.meta.url));

const {
  IMMUTABLE_RESERVATION_STATUSES,
  canReconcileReservation,
  buildReconcileWriteFilter,
  reconcileOrderInventory,
} = await import("../lib/inventoryReservationService.js");

const ORDER_ID = "507f1f77bcf86cd799439011";
const RESERVATION_ID = "507f1f77bcf86cd799439014";

describe("OBS-1: immutable reservation statuses", () => {
  test("CONSUMING cannot be reconciled", () => {
    assert.equal(canReconcileReservation("CONSUMING"), false);
  });

  test("CONSUMED cannot be reconciled", () => {
    assert.equal(canReconcileReservation("CONSUMED"), false);
  });

  test("RELEASED cannot be reconciled", () => {
    assert.equal(canReconcileReservation("RELEASED"), false);
  });

  test("the canonical list is exactly the three immutable statuses", () => {
    assert.deepEqual([...IMMUTABLE_RESERVATION_STATUSES], [
      "CONSUMING",
      "CONSUMED",
      "RELEASED",
    ]);
    assert.equal(Object.isFrozen(IMMUTABLE_RESERVATION_STATUSES), true);
  });

  test("mutable statuses retain reconciliation behavior", () => {
    for (const status of [
      "RESERVED",
      "APPROVED",
      "INSUFFICIENT_STOCK",
      "NO_INVENTORY",
      undefined,
    ]) {
      assert.equal(
        canReconcileReservation(status),
        true,
        `${String(status)} must remain reconcilable`
      );
    }
  });

  test("the atomic write predicate excludes all three immutable statuses", () => {
    const filter = buildReconcileWriteFilter(RESERVATION_ID);
    assert.equal(String(filter._id), RESERVATION_ID);
    assert.deepEqual([...filter.status.$nin], [
      "CONSUMING",
      "CONSUMED",
      "RELEASED",
    ]);
    // The predicate is derived from the canonical list, not a second copy.
    assert.deepEqual([...filter.status.$nin], [...IMMUTABLE_RESERVATION_STATUSES]);
  });

  test("a concurrent status change is not reported as a successful reconcile", async () => {
    const stale = {
      _id: RESERVATION_ID,
      orderId: ORDER_ID,
      status: "RESERVED",
      requirementFingerprint: "stale-fingerprint",
      items: [],
    };
    const claimed = {
      _id: RESERVATION_ID,
      orderId: ORDER_ID,
      status: "CONSUMING",
      requirementFingerprint: "stale-fingerprint",
      items: [],
    };

    // findOne() call order: 1) initial read, 2) in-transaction read,
    // 3) conflict handler's fresh read outside the transaction.
    const reads = [stale, stale, claimed];
    let readIndex = 0;
    const writes = [];

    const Reservation = {
      findOne() {
        const doc = reads[Math.min(readIndex, reads.length - 1)];
        readIndex += 1;
        const query = {
          session: () => query,
          lean: async () => doc,
        };
        return query;
      },
      findOneAndUpdate(filter, update, options) {
        writes.push({ filter, update, options });
        return { lean: async () => null }; // no document matched
      },
    };

    const session = {
      startTransaction() {},
      async commitTransaction() {
        throw new Error("reconciliation must not commit after a failed predicate");
      },
      async abortTransaction() {},
      async endSession() {},
    };

    const conn = {
      models: { InventoryReservation: Reservation, InventoryItem: {} },
      startSession: async () => session,
    };

    const result = await reconcileOrderInventory(conn, { _id: ORDER_ID, items: [] });

    // The write was attempted with the atomic predicate...
    assert.equal(writes.length, 1);
    assert.deepEqual([...writes[0].filter.status.$nin], [
      "CONSUMING",
      "CONSUMED",
      "RELEASED",
    ]);
    // ...it did not match, so the stale snapshot is never returned as success.
    assert.notEqual(result, stale);
    assert.equal(result.status, "CONSUMING");
    assert.equal(readIndex, 3, "the conflict handler must re-read the committed state");
  });

  test("no-match without a replacement document surfaces a conflict", async () => {
    const stale = {
      _id: RESERVATION_ID,
      orderId: ORDER_ID,
      status: "RESERVED",
      requirementFingerprint: "stale-fingerprint",
      items: [],
    };
    // initial read + in-transaction read + deleted-before-fresh-read
    const reads = [stale, stale, null];
    let readIndex = 0;

    const Reservation = {
      findOne() {
        const doc = reads[Math.min(readIndex, reads.length - 1)];
        readIndex += 1;
        const query = { session: () => query, lean: async () => doc };
        return query;
      },
      findOneAndUpdate() {
        return { lean: async () => null };
      },
    };

    const session = {
      startTransaction() {},
      async commitTransaction() {},
      async abortTransaction() {},
      async endSession() {},
    };

    const conn = {
      models: { InventoryReservation: Reservation, InventoryItem: {} },
      startSession: async () => session,
    };

    await assert.rejects(
      () => reconcileOrderInventory(conn, { _id: ORDER_ID, items: [] }),
      (err) => {
        assert.equal(err.name, "InventoryReservationError");
        assert.equal(err.code, "RESERVATION_CONFLICT");
        assert.equal(err.status, 409);
        return true;
      }
    );
  });
});
