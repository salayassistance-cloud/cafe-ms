// WP04-06 R-1 — Read-only scanner tests (DB-free).
//
// Every test uses fakes for the single read primitive. No connection, driver,
// recovery collection, worker, scheduler, or task writer is involved.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ADAPTER_VERSION, collectEvidence } from "../lib/recovery/adapter.js";
import { CLASSIFIER_VERSION, classifyBundles } from "../lib/recovery/classifier.js";
import { projectEvidence } from "../lib/recovery/evidence.js";
import { fingerprintEvidence } from "../lib/recovery/fingerprint.js";
import {
  D06_COVERAGE,
  SCAN_CONSISTENCY,
  SCAN_SCHEMA_VERSION,
  SCANNER_VERSION,
  describeScan,
  scan,
} from "../lib/recovery/scanner.js";
import { createFakeRepositories, oid } from "./helpers/recovery-fakes.mjs";

const SINCE = "2026-11-10T00:00:00.000Z";
const BEFORE_SINCE = "2026-11-09T10:00:00.000Z";
const IN_WINDOW = "2026-11-10T12:00:00.000Z";

const ORDER_ID = oid("a1");
const OTHER_ORDER_ID = oid("a2");
const RESERVATION_ID = oid("b2");
const ITEM_ID = oid("c3");
const LINE_ID = oid("d4");
const MOVEMENT_ID = oid("e5");

function paidOrder(overrides = {}) {
  return {
    _id: ORDER_ID,
    orderNumber: "ORD-1001",
    status: "PAID",
    paidAt: IN_WINDOW,
    createdAt: BEFORE_SINCE,
    updatedAt: IN_WINDOW,
    items: [
      {
        lineId: LINE_ID,
        type: "MENU_ITEM",
        quantity: 1,
        cancelled: false,
        components: [
          {
            componentId: null,
            kind: "RECIPE",
            inventoryItemId: ITEM_ID,
            stockQuantity: 2,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function consumedReservation(overrides = {}) {
  return {
    _id: RESERVATION_ID,
    orderId: ORDER_ID,
    orderNumber: "ORD-1001",
    status: "CONSUMED",
    consumedAt: BEFORE_SINCE,
    consumedTrigger: "PREPARING",
    releasedAt: null,
    releaseReason: null,
    approval: null,
    voids: [],
    items: [
      {
        inventoryItemId: ITEM_ID,
        requiredQuantity: 2,
        reservedQuantity: 2,
        shortageQuantity: 0,
        consumedQuantity: 2,
      },
    ],
    updatedAt: BEFORE_SINCE,
    ...overrides,
  };
}

function saleMovement(overrides = {}) {
  return {
    _id: MOVEMENT_ID,
    refOrderId: ORDER_ID,
    item: ITEM_ID,
    type: "OUT",
    quantity: 2,
    reason: "SaleDeduction",
    idempotencyKey: "sale:ORD-1001",
    voidedAt: null,
    voidReason: null,
    createdAt: BEFORE_SINCE,
    ...overrides,
  };
}

function inventoryItem(overrides = {}) {
  return {
    _id: ITEM_ID,
    currentStock: 8,
    reservedStock: 0,
    ...overrides,
  };
}

function preparationTimeConsumption() {
  return createFakeRepositories({
    orders: [paidOrder()],
    reservations: [consumedReservation()],
    movements: [saleMovement()],
    inventory: [inventoryItem()],
  });
}

function sameIdentifier(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function consumingReservation() {
  return consumedReservation({
    status: "CONSUMING",
    consumedAt: null,
    consumedTrigger: null,
    updatedAt: IN_WINDOW,
    items: [
      {
        inventoryItemId: ITEM_ID,
        requiredQuantity: 2,
        reservedQuantity: 2,
        shortageQuantity: 0,
        consumedQuantity: 0,
      },
    ],
  });
}

// A repository that returns Pass 1 windowed orders and a deliberately smaller
// Pass 2 set, simulating an order deleted/changed between the two reads.
function selectiveOrderRepository(pass1Orders, pass2Orders) {
  const calls = [];
  return {
    name: "orders",
    calls,
    findBounded(filter, projection, options = {}) {
      calls.push(Object.freeze({ filter, projection, options: Object.freeze({ ...options }) }));
      const docs = Object.prototype.hasOwnProperty.call(filter, "_id") ? pass2Orders : pass1Orders;
      return Object.freeze({ docs: Object.freeze(docs.slice(0, options.limit)), truncated: false });
    },
  };
}

describe("WP04-06 R-1 scanner composition and lifecycle", () => {
  it("requires a bounded scan window", async () => {
    const repositories = preparationTimeConsumption();
    await assert.rejects(
      () => scan(repositories, {}),
      (error) => error.code === "MISSING_SCAN_WINDOW",
    );
    await assert.rejects(
      () => scan(repositories, { since: "" }),
      (error) => error.code === "MISSING_SCAN_WINDOW",
    );
    await assert.rejects(
      () => scan(repositories, { since: SINCE, maxOrders: 0 }),
      (error) => error.code === "INVALID_LIMIT",
    );
  });

  it("composes the canonical adapter, classifier, evidence and fingerprint versions", async () => {
    const repositories = preparationTimeConsumption();
    const report = await scan(repositories, { since: SINCE });
    assert.equal(report.schema, SCAN_SCHEMA_VERSION);
    assert.equal(report.scanner, SCANNER_VERSION);
    assert.equal(report.classifier, CLASSIFIER_VERSION);
    assert.equal(report.findingSchema, "wp04-finding-v1");
    assert.equal(report.evidence.schema, ADAPTER_VERSION);
    assert.equal(report.evidence.readOnly, true);
    assert.equal(report.evidence.bundleCount, 1);

    const expected = fingerprintEvidence(
      projectEvidence({
        order: paidOrder(),
        reservation: consumedReservation(),
        movements: [saleMovement()],
        inventory: [inventoryItem()],
      }),
    );
    // No D01 finding for this clean PREPARING-time consumption.
    assert.equal(report.findings.filter((finding) => finding.rule === "D01").length, 0);
    assert.equal(report.readOnly, true);
    assert.equal(report.persisted, false);
    const boundary = describeScan();
    assert.equal(boundary.fingerprintsRawDocuments, false);
    assert.equal(typeof expected.digest, "string");
  });

  it("does not report PAID-without-deduction when consumption happened at PREPARING", async () => {
    const repositories = preparationTimeConsumption();

    // Control: the same windowed single-pass read the scanner replaces.
    const singlePass = await collectEvidence(repositories, {
      since: SINCE,
      ruleScope: "ALL",
      includeConsuming: true,
      includeOrphans: true,
    });
    const singleReport = classifyBundles(singlePass.bundles, {
      since: SINCE,
      indexEvidence: singlePass.indexEvidence,
    });
    assert.ok(
      singleReport.findings.some(
        (finding) => finding.rule === "D01" && finding.code === "PAID_NO_RESERVATION_NO_DEDUCTION",
      ),
      "control must reproduce the false positive the two-pass design prevents",
    );

    // Two-pass scan: full history for the discovered order.
    const report = await scan(repositories, { since: SINCE });
    assert.equal(
      report.findings.filter((finding) => finding.rule === "D01").length,
      0,
      "a PREPARING-time consumption is not a missing deduction",
    );
    assert.equal(report.passes.discovery.orders, 1);
    assert.equal(report.passes.fullHistory.missingOrders, 0);
    assert.equal(report.passes.fullHistory.complete, true);
    assert.equal(report.incompleteEvidence.classificationSuppressed, false);
  });

  it("suppresses every finding for an order missing from the Pass 2 full-history read", async () => {
    const missingOrder = paidOrder({ _id: ORDER_ID, orderNumber: "ORD-MISSING" });
    const unrelatedOrder = paidOrder({
      _id: OTHER_ORDER_ID,
      orderNumber: "ORD-KEPT",
      updatedAt: IN_WINDOW,
    });
    const base = createFakeRepositories({ reservations: [], movements: [], inventory: [] });
    const repositories = Object.freeze({
      orders: selectiveOrderRepository([missingOrder, unrelatedOrder], [unrelatedOrder]),
      reservations: base.reservations,
      movements: base.movements,
      inventory: base.inventory,
    });

    const report = await scan(repositories, { since: SINCE });

    assert.equal(report.passes.discovery.orders, 2);
    assert.equal(report.passes.fullHistory.missingOrders, 1);
    assert.equal(report.incompleteEvidence.classificationSuppressed, true);
    assert.equal(report.incompleteEvidence.reason, "ORDER_MISSING_FROM_FULL_HISTORY_PASS");
    assert.equal(report.consistency.complete, false);
    assert.deepEqual(report.passes.fullHistory.missingOrderIds, [ORDER_ID]);
    assert.deepEqual(report.incompleteEvidence.missingOrderIds, [ORDER_ID]);

    // No finding may reference the missing order, even though its windowed Pass 1
    // bundle looks exactly like a PAID order with no reservation/deduction.
    assert.equal(
      report.findings.filter((finding) => sameIdentifier(finding.orderId, ORDER_ID)).length,
      0,
      "incomplete evidence must not produce any finding",
    );
    assert.equal(
      report.findings.filter((finding) => finding.orderNumber === "ORD-MISSING").length,
      0,
    );

    // Findings for the unrelated complete order are preserved.
    const kept = report.findings.filter(
      (finding) => finding.orderNumber === "ORD-KEPT" && sameIdentifier(finding.orderId, OTHER_ORDER_ID),
    );
    assert.ok(kept.length > 0, "valid findings for unrelated orders must be preserved");
    assert.ok(kept.every((finding) => finding.orderNumber === "ORD-KEPT"));
  });

  it("does not classify a windowed Pass 1 bundle as a fallback when Pass 2 is empty", async () => {
    const missingOrder = paidOrder({ _id: ORDER_ID, orderNumber: "ORD-MISSING" });
    const base = createFakeRepositories({ reservations: [], movements: [], inventory: [] });
    const repositories = Object.freeze({
      orders: selectiveOrderRepository([missingOrder], []),
      reservations: base.reservations,
      movements: base.movements,
      inventory: base.inventory,
    });
    const report = await scan(repositories, { since: SINCE });
    assert.equal(report.findings.length, 0);
    assert.equal(report.summary.findings, 0);
    assert.equal(report.passes.fullHistory.missingOrders, 1);
    assert.equal(report.incompleteEvidence.failClosed, true);
  });

  it("fails closed when a bounded read reports truncation", async () => {
    const base = createFakeRepositories({ orders: [paidOrder()], reservations: [], inventory: [] });
    const truncatedMovements = Object.freeze({
      findBounded: async () => ({ docs: [], truncated: true }),
    });
    const repositories = Object.freeze({
      orders: base.orders,
      reservations: base.reservations,
      movements: truncatedMovements,
      inventory: base.inventory,
    });
    await assert.rejects(
      () => scan(repositories, { since: SINCE }),
      (error) => error.code === "EVIDENCE_BOUND_EXCEEDED",
    );
  });

  it("reports the two-pass consistency limitation instead of claiming a snapshot", async () => {
    const report = await scan(preparationTimeConsumption(), { since: SINCE });
    assert.equal(report.consistency.mechanism, SCAN_CONSISTENCY.mechanism);
    assert.equal(report.consistency.snapshot, false);
    assert.equal(report.consistency.transaction, false);
    assert.equal(report.consistency.atomic, false);
    assert.equal(report.consistency.readConcern, null);
    assert.match(report.consistency.limitation, /independent, non-transactional/i);
    assert.match(report.consistency.limitation, /suppressed/i);

    const boundary = describeScan();
    assert.equal(boundary.consistency.snapshot, false);
    assert.equal(boundary.consistency.transaction, false);
    assert.equal(boundary.passConsistencyGuaranteed, false);
    assert.equal(boundary.incompleteEvidenceFailsClosed, true);
  });
});

describe("WP04-06 R-1 scanner D06 coverage and evidence boundaries", () => {
  it("surfaces a live CONSUMING reservation as ALERT_ONLY and states the coverage limit", async () => {
    const repositories = createFakeRepositories({
      orders: [
        paidOrder({
          status: "PREPARING",
          paidAt: null,
          updatedAt: "2026-10-01T00:00:00.000Z",
        }),
      ],
      reservations: [consumingReservation()],
      movements: [],
      inventory: [inventoryItem()],
    });

    const report = await scan(repositories, { since: SINCE });
    const d06 = report.findings.filter((finding) => finding.rule === "D06");
    assert.equal(d06.length, 1);
    assert.equal(d06[0].classification, "ALERT");
    assert.equal(d06[0].code, "CONSUMING_ABANDONED");
    assert.equal(d06[0].createsRecoveryTask, false);
    assert.ok(report.deferred.length > 0, "stale age is deferred, not guessed");

    assert.equal(report.discoveryCoverage.d06.exhaustive, false);
    assert.equal(report.discoveryCoverage.d06.classification, "ALERT_ONLY");
    assert.equal(
      report.discoveryCoverage.d06.discoveryMechanism,
      "WINDOWED_CONSUMING_RESERVATION_READ",
    );
    assert.equal(
      report.discoveryCoverage.d06.absenceMeaning,
      "NO_STALE_CONSUMING_OBSERVED_IN_SCANNED_WINDOW",
    );
    assert.match(report.discoveryCoverage.d06.limitation, /does not\s+prove/i);
    assert.deepEqual(report.discoveryCoverage.d06.window, {
      since: SINCE,
      until: null,
    });

    const boundary = describeScan();
    assert.equal(boundary.d06DiscoveryExhaustive, false);
    assert.equal(boundary.d06.exhaustive, false);
    assert.equal(D06_COVERAGE.exhaustive, false);
  });

  it("does not claim exhaustive discovery when an old CONSUMING reservation is outside the window", async () => {
    const repositories = createFakeRepositories({
      orders: [
        paidOrder({
          status: "PREPARING",
          paidAt: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        }),
      ],
      reservations: [
        consumedReservation({
          status: "CONSUMING",
          consumedAt: null,
          consumedTrigger: null,
          updatedAt: "2026-09-02T00:00:00.000Z",
          items: [
            {
              inventoryItemId: ITEM_ID,
              requiredQuantity: 2,
              reservedQuantity: 2,
              shortageQuantity: 0,
              consumedQuantity: 0,
            },
          ],
        }),
      ],
      movements: [],
      inventory: [inventoryItem()],
    });

    const report = await scan(repositories, { since: SINCE });
    assert.equal(report.summary.byRule.D06, 0);
    assert.equal(report.discoveryCoverage.d06.exhaustive, false);
    assert.equal(
      report.discoveryCoverage.d06.absenceMeaning,
      "NO_STALE_CONSUMING_OBSERVED_IN_SCANNED_WINDOW",
    );
    // The report must not present absence as proof.
    assert.doesNotMatch(
      JSON.stringify(report.discoveryCoverage),
      /no stale CONSUMING (state )?exists/i,
    );
  });

  it("preserves orphan movement evidence without inventing an order", async () => {
    const orphanOrderId = oid("f6");
    const repositories = createFakeRepositories({
      orders: [],
      reservations: [],
      movements: [
        saleMovement({
          _id: oid("07"),
          refOrderId: orphanOrderId,
          idempotencyKey: "orphan:1",
          createdAt: IN_WINDOW,
        }),
      ],
      inventory: [inventoryItem()],
    });
    const report = await scan(repositories, { since: SINCE });
    assert.equal(report.passes.discovery.orphanBundles, 1);
    const d02 = report.findings.filter((finding) => finding.rule === "D02");
    assert.ok(d02.length > 0, "an orphan sale movement must be reported");
  });

  it("fingerprints only projected evidence and never raw documents", async () => {
    const order = paidOrder({
      status: "PREPARING",
      paidAt: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
      rawDocumentSecret: "SHOULD_NOT_APPEAR",
    });
    const reservation = {
      ...consumingReservation(),
      rawDocumentSecret: "SHOULD_NOT_APPEAR",
    };
    const repositories = createFakeRepositories({
      orders: [order],
      reservations: [reservation],
      movements: [],
      inventory: [inventoryItem()],
    });

    const report = await scan(repositories, { since: SINCE });
    const expected = fingerprintEvidence(
      projectEvidence({ order, reservation, movements: [], inventory: [inventoryItem()] }),
    );
    const d06 = report.findings.find((finding) => finding.rule === "D06");
    assert.ok(d06);
    assert.equal(d06.evidenceFingerprint, expected.digest);
    assert.equal(JSON.stringify(report).includes("SHOULD_NOT_APPEAR"), false);
  });

  it("never creates or reopens a recovery task and never persists findings", async () => {
    const repositories = createFakeRepositories({
      orders: [paidOrder({ items: [] })],
      reservations: [],
      movements: [],
      inventory: [],
    });
    const report = await scan(repositories, { since: SINCE });
    const d01 = report.findings.filter((finding) => finding.rule === "D01");
    assert.ok(d01.length > 0, "expected a D01 finding for a PAID order with no reservation");
    for (const finding of report.findings) {
      assert.equal(finding.createsRecoveryTask, false);
      assert.equal(finding.autoRecovery, "PROHIBITED");
      assert.equal(finding.readOnly, true);
      assert.equal(finding.task, null);
    }
    assert.equal(report.persisted, false);

    // OD-40: recurrence after closure has no task-creation or reopening path
    // here, and the scanner never reads or writes a recovery collection.
    for (const name of ["orders", "reservations", "movements", "inventory"]) {
      const calls = repositories[name].calls;
      if (name === "inventory") continue; // no item ids in this bundle, so no inventory read is required
      assert.ok(calls.length > 0, `${name} should be read`);
      for (const call of calls) {
        const filterText = JSON.stringify(call.filter);
        assert.equal(filterText.includes("inventory_recovery"), false);
      }
    }
    const boundary = describeScan();
    assert.equal(boundary.createsRecoveryTasks, false);
    assert.equal(boundary.reopensClosedTasks, false);
  });

  it("returns a deeply frozen, deterministic report", async () => {
    const first = await scan(preparationTimeConsumption(), { since: SINCE });
    const second = await scan(preparationTimeConsumption(), { since: SINCE });
    assert.deepEqual(first.summary, second.summary);
    assert.deepEqual(first.findings, second.findings);
    assert.deepEqual(first.deferred, second.deferred);

    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.findings), true);
    assert.equal(Object.isFrozen(first.deferred), true);
    assert.equal(Object.isFrozen(first.evidence), true);
    assert.equal(Object.isFrozen(first.evidence.bounds), true);
    assert.equal(Object.isFrozen(first.passes), true);
    assert.equal(Object.isFrozen(first.passes.fullHistory), true);
    assert.equal(Object.isFrozen(first.consistency), true);
    assert.equal(Object.isFrozen(first.discoveryCoverage), true);
    assert.equal(Object.isFrozen(first.incompleteEvidence), true);
  });
});
