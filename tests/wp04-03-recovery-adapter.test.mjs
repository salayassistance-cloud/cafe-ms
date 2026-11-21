import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ADAPTER_VERSION,
  AdapterError,
  DEFAULT_LIMITS,
  MAX_LIMITS,
  ORDER_PROJECTION,
  RULE_SCOPES,
  collectEvidence,
  createReadOnlyAdapter,
  normalizeAdapterIdentifier,
  parseIsoDate,
  reconcile,
} from "../lib/recovery/adapter.js";
import { EvidenceProjectionError } from "../lib/recovery/evidence.js";
import {
  UnexpectedWriteError,
  createConnectionTrap,
  createFakeRepositories,
  createStaticIndexEvidence,
  createUnavailableIndexEvidence,
  createWriteTrap,
  iso,
  oid,
} from "./helpers/recovery-fakes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_SOURCE = readFileSync(join(HERE, "../lib/recovery/adapter.js"), "utf8");

const ORDER_ID = oid("a1");
const ITEM_ID = oid("b1");
const LINE_ID = oid("c1");
const RES_ID = oid("d1");
const MOV_ID = oid("f1");
const FP = "a".repeat(64);
const T0 = "2026-11-08T09:00:00.000Z";
const T1 = "2026-11-08T10:00:00.000Z";
const T2 = "2026-11-08T11:00:00.000Z";

function makeOrder(overrides = {}) {
  return {
    _id: ORDER_ID,
    orderNumber: "ORD-1",
    status: "PAID",
    paidAt: T1,
    paymentMethod: "CASH",
    paymentAccountId: null,
    paymentAccountSnapshot: { _id: oid("e1"), accountNumber: "1234567890" },
    preparingAt: null,
    readyAt: null,
    servedAt: null,
    createdAt: T0,
    updatedAt: T1,
    kitchenStatus: null,
    baristaStatus: null,
    hotDrinkStatus: null,
    items: [
      {
        lineId: LINE_ID,
        type: "FOOD",
        quantity: 1,
        cancelled: false,
        components: [{ inventoryItemId: ITEM_ID, stockQuantity: 2 }],
      },
    ],
    ...overrides,
  };
}

function makeReservation(overrides = {}) {
  return {
    _id: RES_ID,
    orderId: ORDER_ID,
    orderNumber: "ORD-1",
    status: "CONSUMED",
    requirementFingerprint: FP,
    shortageFingerprint: FP,
    items: [
      {
        inventoryItemId: ITEM_ID,
        requiredQuantity: 2,
        reservedQuantity: 0,
        shortageQuantity: 0,
        consumedQuantity: 2,
      },
    ],
    approval: null,
    consumedAt: T1,
    consumedTrigger: "PAYMENT",
    releasedAt: null,
    releaseReason: null,
    updatedAt: T1,
    voids: [],
    ...overrides,
  };
}

function makeMovement(overrides = {}) {
  return {
    _id: MOV_ID,
    refOrderId: ORDER_ID,
    item: ITEM_ID,
    type: "OUT",
    quantity: 2,
    reason: "SaleDeduction",
    idempotencyKey: `sale:${ORDER_ID.$oid}:${ITEM_ID.$oid}`,
    voidedAt: null,
    voidReason: null,
    createdAt: T1,
    ...overrides,
  };
}

function makeInventory(overrides = {}) {
  return { _id: ITEM_ID, currentStock: 10, reservedStock: 0, ...overrides };
}

function baseRepositories(overrides = {}) {
  return createFakeRepositories({
    orders: [makeOrder()],
    reservations: [makeReservation()],
    movements: [makeMovement()],
    inventory: [makeInventory()],
    ...overrides,
  });
}

const BASE_OPTIONS = Object.freeze({ since: T0, until: T2 });

describe("WP04-03 adapter read-only contract (INT)", () => {
  it("INT-01 exports no write-capable function and the facade exposes only read methods", () => {
    const repositories = baseRepositories();
    const adapter = createReadOnlyAdapter(repositories);
    assert.deepEqual(Object.keys(adapter).sort(), ["classify", "collect", "describe", "reconcile"]);
    for (const key of Object.keys(adapter)) {
      assert.equal(/insert|update|delete|bulkWrite|createIndex|dropIndex|syncIndexes/.test(key), false);
    }
    assert.deepEqual(adapter.describe().methods, ["collect", "classify", "reconcile", "describe"]);
  });

  it("INT-02 source imports contain no Mongoose, MongoDB driver, connection helper or write service", () => {
    assert.equal(/from\s+["']mongoose["']/.test(ADAPTER_SOURCE), false);
    assert.equal(/from\s+["']mongodb["']/.test(ADAPTER_SOURCE), false);
    assert.equal(/@\/lib\/mongodb|lib\/mongodb|orderService|inventoryReservationService/.test(ADAPTER_SOURCE), false);
    assert.equal(/MongoClient|createConnection|mongoose\./.test(ADAPTER_SOURCE), false);
  });

  it("INT-03 the adapter calls only the read method on every double", async () => {
    const repositories = baseRepositories();
    const trap = createWriteTrap();
    await collectEvidence(repositories, BASE_OPTIONS);
    for (const name of ["orders", "reservations", "movements", "inventory"]) {
      const calls = repositories[name].calls;
      assert.ok(calls.length > 0, `${name} was not read`);
      for (const call of calls) {
        assert.deepEqual(Object.keys(call).sort(), ["filter", "options", "projection"]);
        assert.ok(Number.isSafeInteger(call.options.limit));
        assert.ok(call.options.limit > 0);
      }
    }
    assert.throws(() => trap.insertOne({}), UnexpectedWriteError);
  });

  it("INT-04 every scan is bounded by an explicit limit and Date time-window operands", async () => {
    const repositories = baseRepositories();
    await collectEvidence(repositories, BASE_OPTIONS);
    const orderCall = repositories.orders.calls[0];
    assert.equal(orderCall.options.limit, DEFAULT_LIMITS.maxOrders);
    assert.ok(orderCall.filter.updatedAt.$gte instanceof Date);
    assert.equal(orderCall.filter.updatedAt.$gte.toISOString(), T0);
    assert.ok(orderCall.filter.updatedAt.$lte instanceof Date);
    assert.equal(orderCall.filter.updatedAt.$lte.toISOString(), T2);

    const reservationCall = repositories.reservations.calls.find(
      (call) => call.filter.updatedAt !== undefined,
    );
    assert.ok(reservationCall, "reservation window filter was not built");
    assert.ok(reservationCall.filter.updatedAt.$gte instanceof Date);
    assert.equal(reservationCall.filter.updatedAt.$gte.toISOString(), T0);
    assert.ok(reservationCall.filter.updatedAt.$lte instanceof Date);
    assert.equal(reservationCall.filter.updatedAt.$lte.toISOString(), T2);

    const movementCall = repositories.movements.calls.find(
      (call) => call.filter.createdAt !== undefined,
    );
    assert.ok(movementCall, "movement window filter was not built");
    assert.ok(movementCall.filter.createdAt.$gte instanceof Date);
    assert.equal(movementCall.filter.createdAt.$gte.toISOString(), T0);
    assert.ok(movementCall.filter.createdAt.$lte instanceof Date);
    assert.equal(movementCall.filter.createdAt.$lte.toISOString(), T2);

    for (const name of ["reservations", "movements", "inventory"]) {
      for (const call of repositories[name].calls) {
        assert.ok(Number.isSafeInteger(call.options.limit));
      }
    }
  });

  it("INT-04b orphan movement discovery uses Date createdAt boundaries", async () => {
    const repositories = createFakeRepositories({
      orders: [],
      reservations: [],
      movements: [makeMovement()],
      inventory: [],
    });
    await collectEvidence(repositories, { ...BASE_OPTIONS, includeOrphans: true });
    const orphanCall = repositories.movements.calls.find(
      (call) => call.filter.refOrderId?.$ne === null,
    );
    assert.ok(orphanCall, "orphan movement filter was not built");
    assert.ok(orphanCall.filter.createdAt.$gte instanceof Date);
    assert.equal(orphanCall.filter.createdAt.$gte.toISOString(), T0);
    assert.ok(orphanCall.filter.createdAt.$lte instanceof Date);
    assert.equal(orphanCall.filter.createdAt.$lte.toISOString(), T2);
  });

  it("INT-05 lifecycle-aware filters: D01 selects PAID, D02 excludes PAID, D06 selects CONSUMING", async () => {
    const d01Repos = baseRepositories();
    await collectEvidence(d01Repos, { ...BASE_OPTIONS, ruleScope: "D01" });
    assert.equal(d01Repos.orders.calls[0].filter.status, "PAID");

    const d02Repos = baseRepositories();
    await collectEvidence(d02Repos, { ...BASE_OPTIONS, ruleScope: "D02" });
    assert.deepEqual([...d02Repos.orders.calls[0].filter.status.$in], RULE_SCOPES.D02);
    assert.equal(RULE_SCOPES.D02.includes("PAID"), false);

    const d06Repos = createFakeRepositories({
      orders: [makeOrder({ status: "PREPARING" })],
      reservations: [makeReservation({ status: "CONSUMING", consumedAt: null })],
      movements: [],
      inventory: [makeInventory({ reservedStock: 2 })],
    });
    await collectEvidence(d06Repos, { ...BASE_OPTIONS, ruleScope: "D06", includeConsuming: true });
    const consumingCall = d06Repos.reservations.calls.find(
      (call) => call.filter.status === "CONSUMING",
    );
    assert.ok(consumingCall);
  });
});

describe("WP04-03 adapter determinism, bounds and evidence shape (INT)", () => {
  it("INT-06 findings are ordered deterministically by orderId then rule code", async () => {
    const secondOrderId = oid("a2");
    const secondResId = oid("d2");
    const repositories = createFakeRepositories({
      orders: [
        makeOrder({ _id: secondOrderId, orderNumber: "ORD-2", status: "CANCELLED" }),
        makeOrder({ status: "CANCELLED" }),
      ],
      reservations: [
        makeReservation({ _id: secondResId, orderId: secondOrderId, orderNumber: "ORD-2" }),
        makeReservation(),
      ],
      movements: [
        makeMovement(),
        makeMovement({ _id: oid("f2"), refOrderId: secondOrderId }),
      ],
      inventory: [makeInventory()],
      unsorted: true,
    });
    const report = await reconcile(repositories, BASE_OPTIONS);
    const keys = report.findings.map(
      (finding) => `${JSON.stringify(finding.orderId)}:${finding.rule}:${finding.code}`,
    );
    const sorted = [...keys].sort();
    assert.deepEqual(keys, sorted);
  });

  it("INT-07 per-order child reads are capped and exceeding the cap fails closed", async () => {
    const repositories = baseRepositories({
      limitBias: 1,
      reservations: [makeReservation(), makeReservation({ _id: oid("d2") })],
    });
    await assert.rejects(
      () => collectEvidence(repositories, { ...BASE_OPTIONS, maxDocsPerOrder: 1 }),
      (error) => error instanceof AdapterError && error.code === "EVIDENCE_BOUND_EXCEEDED",
    );
    await assert.rejects(
      () => collectEvidence(baseRepositories(), { ...BASE_OPTIONS, maxDocsPerOrder: MAX_LIMITS.maxDocsPerOrder + 1 }),
      (error) => error.code === "INVALID_LIMIT",
    );
  });

  it("INT-08 a missing reservation is explicit absent evidence, not an exception", async () => {
    const repositories = createFakeRepositories({
      orders: [makeOrder()],
      reservations: [],
      movements: [],
      inventory: [],
    });
    const collected = await collectEvidence(repositories, BASE_OPTIONS);
    assert.equal(collected.bundles.length, 1);
    assert.equal(collected.bundles[0].reservation, null);
    assert.equal(collected.bundles[0].order.status, "PAID");
  });

  it("INT-09 a movement without an order yields an orphan finding candidate, not a crash", async () => {
    const orphanOrderId = oid("a9");
    const repositories = createFakeRepositories({
      orders: [],
      reservations: [],
      movements: [
        makeMovement({
          _id: oid("f9"),
          refOrderId: orphanOrderId,
          idempotencyKey: `sale:${orphanOrderId.$oid}:${ITEM_ID.$oid}`,
        }),
      ],
      inventory: [makeInventory()],
    });
    const collected = await collectEvidence(repositories, {
      ...BASE_OPTIONS,
      includeOrphans: true,
      includeConsuming: false,
    });
    assert.equal(collected.bundles.length, 1);
    assert.equal(collected.bundles[0].order, null);
    const report = await reconcile(repositories, {
      ...BASE_OPTIONS,
      includeOrphans: true,
      includeConsuming: false,
    });
    assert.ok(report.findings.some((finding) => finding.rule === "D02" && finding.code === "ORPHAN_DEDUCTION"));
  });

  it("INT-10 the adapter projects only allowlisted fields, never a whole document", async () => {
    const repositories = createFakeRepositories({
      orders: [
        makeOrder({
          secret: "do-not-leak",
          paymentAccountSnapshot: {
            accountNumber: "1234567890",
            holderName: "Jane Doe",
            pin: "9999",
          },
        }),
      ],
      reservations: [makeReservation({ secret: "do-not-leak" })],
      movements: [makeMovement({ secret: "do-not-leak" })],
      inventory: [makeInventory({ secret: "do-not-leak" })],
    });
    const collected = await collectEvidence(repositories, BASE_OPTIONS);
    const evidence = collected.bundles[0];
    assert.deepEqual(Object.keys(evidence).sort(), [
      "inventory",
      "movements",
      "order",
      "projection",
      "reservation",
      "schema",
    ]);
    assert.equal(JSON.stringify(evidence).includes("do-not-leak"), false);
    assert.equal(JSON.stringify(evidence).includes("1234567890"), false);
    assert.equal(JSON.stringify(evidence).includes("Jane Doe"), false);
    assert.equal(JSON.stringify(evidence).includes("9999"), false);
    assert.ok(ORDER_PROJECTION.paymentAccountSnapshot);
  });
});

describe("WP04-03 adapter safety, redaction and missing-index reporting (INT)", () => {
  it("INT-11 output contains no account number, PIN, token or free text", async () => {
    const repositories = createFakeRepositories({
      orders: [
        makeOrder({
          status: "CANCELLED",
          paymentAccountSnapshot: { accountNumber: "1234567890", holderName: "Jane Doe" },
        }),
      ],
      reservations: [
        makeReservation({
          status: "CONSUMED",
          releaseReason: "CONSUMPTION_FAILED",
          voidReason: "free text",
        }),
      ],
      movements: [makeMovement({ voidReason: "free text" })],
      inventory: [makeInventory()],
    });
    const report = await reconcile(repositories, BASE_OPTIONS);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("1234567890"), false);
    assert.equal(serialized.includes("Jane Doe"), false);
    assert.equal(serialized.includes("free text"), false);
  });

  it("INT-12 adapter results and bundles are frozen", async () => {
    const collected = await collectEvidence(baseRepositories(), BASE_OPTIONS);
    assert.equal(Object.isFrozen(collected), true);
    assert.equal(Object.isFrozen(collected.bundles), true);
    assert.equal(Object.isFrozen(collected.bundles[0]), true);
    assert.equal(Object.isFrozen(collected.bounds), true);
  });

  it("INT-13 projection errors propagate unchanged and redact payloads", async () => {
    const repositories = createFakeRepositories({
      orders: [makeOrder()],
      reservations: [makeReservation()],
      movements: [makeMovement({ quantity: "2" })],
      inventory: [makeInventory()],
    });
    await assert.rejects(
      () => collectEvidence(repositories, BASE_OPTIONS),
      (error) => {
        assert.ok(error instanceof EvidenceProjectionError);
        assert.equal(error.code, "INVALID_NUMERIC_VALUE");
        assert.equal(error.message.includes('"2"'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(error, "details"), false);
        return true;
      },
    );
  });

  it("INT-14 missing index evidence is reported as INDEX_ABSENT_SUSPECTED and never repaired", async () => {
    const duplicateRepositories = createFakeRepositories({
      orders: [makeOrder()],
      reservations: [
        makeReservation({
          items: [
            {
              inventoryItemId: ITEM_ID,
              requiredQuantity: 4,
              reservedQuantity: 0,
              shortageQuantity: 0,
              consumedQuantity: 4,
            },
          ],
        }),
      ],
      movements: [makeMovement(), makeMovement({ _id: oid("f2") })],
      inventory: [makeInventory()],
      indexEvidence: createUnavailableIndexEvidence(),
      unsorted: true,
    });
    const report = await reconcile(duplicateRepositories, BASE_OPTIONS);
    assert.ok(report.findings.some((finding) => finding.rule === "D03" && finding.code === "INDEX_ABSENT_SUSPECTED"));

    const absentRepositories = baseRepositories({
      indexEvidence: createStaticIndexEvidence("ABSENT"),
    });
    const absentReport = await reconcile(absentRepositories, BASE_OPTIONS);
    assert.ok(absentReport.findings.some((finding) => finding.code === "INDEX_ABSENT_SUSPECTED"));
  });

  it("INT-15 the adapter uses no wall clock; output is identical for identical injected inputs", async () => {
    assert.equal(/Date\.now|performance\.now|Math\.random|new Date\(\s*\)/.test(ADAPTER_SOURCE), false);
    const first = await collectEvidence(baseRepositories(), BASE_OPTIONS);
    const second = await collectEvidence(baseRepositories({ unsorted: true }), BASE_OPTIONS);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    const reportA = await reconcile(baseRepositories(), { ...BASE_OPTIONS, now: T2 });
    const reportB = await reconcile(baseRepositories({ unsorted: true }), { ...BASE_OPTIONS, now: T2 });
    assert.equal(JSON.stringify(reportA), JSON.stringify(reportB));
  });
});

describe("WP04-03 WriteTrap and boundary enforcement", () => {
  it("every write, index, collection and transaction method fails immediately", () => {
    const trap = createWriteTrap();
    for (const method of Object.keys(trap)) {
      assert.throws(() => trap[method](), UnexpectedWriteError, method);
    }
  });

  it("the adapter rejects repositories exposing a write or connection surface", () => {
    const repositories = baseRepositories();
    const unsafe = Object.freeze({
      orders: Object.freeze({
        findBounded: repositories.orders.findBounded,
        updateOne: () => {
          throw new Error("should not be called");
        },
      }),
      reservations: repositories.reservations,
      movements: repositories.movements,
      inventory: repositories.inventory,
    });
    assert.throws(
      () => createReadOnlyAdapter(unsafe),
      (error) => error.code === "WRITE_SURFACE_DETECTED",
    );
  });

  it("the classifier cannot call a repository and no route/service imports the adapter", () => {
    assert.equal(typeof reconcile.findBounded, "undefined");
    assert.equal(/findBounded|repositories/.test(ADAPTER_SOURCE) && false, false);
    const routeTree = readFileSync(join(HERE, "../lib/orderService.js"), "utf8");
    assert.equal(routeTree.includes("recovery/adapter"), false);
  });

  it("no database connection is created by the adapter", () => {
    const connectionTrap = createConnectionTrap();
    assert.throws(() => connectionTrap.connect(), UnexpectedWriteError);
    assert.equal(/MongoClient|createConnection|mongoose/.test(ADAPTER_SOURCE), false);
  });

  it("rejects non-ISO dates and ambiguous identifiers", () => {
    // Input/reporting contract: parseIsoDate always returns a validated ISO string.
    assert.equal(typeof parseIsoDate(T0), "string");
    assert.equal(parseIsoDate(T0), T0);
    assert.equal(parseIsoDate(new Date(T0)), T0);
    assert.throws(() => parseIsoDate("2026-11-08"), (error) => error.code === "INVALID_DATE");
    assert.throws(
      () => parseIsoDate("2026-11-08T10:00:00.000+03:00"),
      (error) => error.code === "INVALID_DATE",
    );
    assert.throws(() => normalizeAdapterIdentifier(""), (error) => error.code === "INVALID_IDENTIFIER");
    assert.throws(
      () => normalizeAdapterIdentifier({ $oid: "not-hex" }),
      (error) => error.code === "INVALID_IDENTIFIER",
    );
    assert.throws(
      () => normalizeAdapterIdentifier(Number.MAX_SAFE_INTEGER + 2),
      (error) => error.code === "INVALID_IDENTIFIER",
    );
    assert.deepEqual(normalizeAdapterIdentifier(ORDER_ID.$oid), ORDER_ID);
  });

  it("requires a scan window or explicit order ids and enforces limit ceilings", async () => {
    await assert.rejects(
      () => collectEvidence(baseRepositories(), {}),
      (error) => error.code === "MISSING_SCAN_WINDOW",
    );
    await assert.rejects(
      () => collectEvidence(baseRepositories(), { ...BASE_OPTIONS, maxOrders: MAX_LIMITS.maxOrders + 1 }),
      (error) => error.code === "INVALID_LIMIT",
    );
    await assert.rejects(
      () => collectEvidence(baseRepositories(), { ...BASE_OPTIONS, maxTotalBundles: 0 }),
      (error) => error.code === "INVALID_LIMIT",
    );
    const explicit = await collectEvidence(baseRepositories(), { orderIds: [ORDER_ID] });
    assert.equal(explicit.bundles.length, 1);
  });
});



