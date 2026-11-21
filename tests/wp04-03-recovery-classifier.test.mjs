import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  FINDING_SCHEMA_VERSION,
  CLASSIFIER_VERSION,
  ClassifierError,
  assertFindingCode,
  classifyBundles,
  classifyEvidence,
} from "../lib/recovery/classifier.js";
import { RULES, RULES_BY_ID } from "../lib/recovery/rules/registry.js";
import { projectEvidence } from "../lib/recovery/evidence.js";
import { fingerprintEvidence } from "../lib/recovery/fingerprint.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLASSIFIER_SOURCE = readFileSync(join(HERE, "../lib/recovery/classifier.js"), "utf8");

const ORDER_ID = Object.freeze({ $oid: "0000000000000000000000a1" });
const ITEM_ID = Object.freeze({ $oid: "0000000000000000000000b1" });
const ITEM2_ID = Object.freeze({ $oid: "0000000000000000000000b2" });
const LINE_ID = Object.freeze({ $oid: "0000000000000000000000c1" });
const RES_ID = Object.freeze({ $oid: "0000000000000000000000d1" });
const RES2_ID = Object.freeze({ $oid: "0000000000000000000000d2" });
const PAY_ID = Object.freeze({ $oid: "0000000000000000000000e1" });
const MOV_ID = Object.freeze({ $oid: "0000000000000000000000f1" });
const MOV2_ID = Object.freeze({ $oid: "0000000000000000000000f2" });
const FP = "a".repeat(64);
const FP2 = "b".repeat(64);

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
    paymentAccountSnapshot: { accountNumber: "1234567890", holderName: "Jane Doe" },
    paymentSubmittedAt: T0,
    paymentSubmittedBy: null,
    paymentVerifiedAt: null,
    paymentVerifiedBy: null,
    paymentRejectedAt: null,
    paymentRejectedBy: null,
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
        name: "Secret Dish",
        components: [
          { componentId: null, kind: "INVENTORY", inventoryItemId: ITEM_ID, stockQuantity: 2 },
        ],
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

function project(raw) {
  return projectEvidence(raw);
}

function classify(raw, options) {
  return classifyEvidence(project(raw), options);
}

function rulesOf(report) {
  return report.findings.map((finding) => finding.rule);
}

function codesOf(report, rule) {
  return report.findings.filter((finding) => finding.rule === rule).map((finding) => finding.code);
}

function bundle(raw) {
  return { evidence: project(raw) };
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).reverse()) out[key] = reverseKeys(value[key]);
  return out;
}

describe("WP04-03 classifier contract (CLS)", () => {
  it("CLS-01 emits only the frozen D01-D10 vocabulary and rejects unknown rules", () => {
    assert.deepEqual(
      RULES.map((rule) => rule.id),
      ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09", "D10"],
    );
    assert.equal(assertFindingCode("D01", "PAID_RELEASED_NO_DEDUCTION"), true);
    assert.throws(() => assertFindingCode("R9", "ANY"), /unknown rule id/);
    assert.throws(() => assertFindingCode("D01", "NOT_A_CODE"), /unknown sub-code/);

    const report = classify({
      order: makeOrder({ status: "PAID" }),
      reservation: makeReservation({
        status: "RELEASED",
        releaseReason: "CONSUMPTION_FAILED",
        items: [
          {
            inventoryItemId: ITEM_ID,
            requiredQuantity: 2,
            reservedQuantity: 0,
            shortageQuantity: 0,
            consumedQuantity: 0,
          },
        ],
      }),
      movements: [],
      inventory: [makeInventory()],
    });
    for (const finding of report.findings) {
      assert.ok(RULES_BY_ID[finding.rule], `unknown rule ${finding.rule}`);
      assert.ok(RULES_BY_ID[finding.rule].subCodes.includes(finding.code));
    }
    assert.equal(report.schema, FINDING_SCHEMA_VERSION);
    assert.equal(report.classifier, CLASSIFIER_VERSION);
    assert.equal(report.readOnly, true);
  });

  it("CLS-02 D02 and D09 are finding codes only, never durable classes or tasks", () => {
    const d02 = classify({
      order: makeOrder({ status: "CANCELLED" }),
      reservation: makeReservation({ status: "RELEASED", releaseReason: "CANCELLED" }),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    const d09 = classify({
      order: makeOrder({ status: "PAYMENT_PENDING", paidAt: T1 }),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    for (const report of [d02, d09]) {
      assert.ok(report.findings.length > 0);
      for (const finding of report.findings.filter((f) => f.rule === "D02" || f.rule === "D09")) {
        assert.equal(finding.findingCodeOnly, true);
        assert.equal(finding.durableClass, false);
        assert.equal(finding.createsRecoveryTask, false);
        assert.equal(finding.task, null);
      }
    }
  });

  it("CLS-03 D06 is ALERT_ONLY and creates no recovery task", () => {
    const report = classify({
      order: makeOrder({ status: "PREPARING" }),
      reservation: makeReservation({ status: "CONSUMING", consumedAt: null, consumedQuantity: 0 }),
      movements: [],
      inventory: [makeInventory()],
    });
    const alerts = report.findings.filter((finding) => finding.rule === "D06");
    assert.ok(alerts.length > 0);
    for (const alert of alerts) {
      assert.equal(alert.classification, "ALERT");
      assert.equal(alert.taskCreationPolicy, "ALERT_ONLY");
      assert.equal(alert.createsRecoveryTask, false);
      assert.equal(alert.task, null);
      assert.equal(alert.thresholdState, "W_STALE_UNSET");
      assert.equal(alert.autoRecovery, "PROHIBITED");
    }
  });

  it("CLS-04 no finding authorizes repair, correction quantity, or a task", () => {
    const report = classify({
      order: makeOrder({ status: "CANCELLED" }),
      reservation: makeReservation({ status: "CONSUMED" }),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    for (const finding of report.findings) {
      assert.equal(finding.autoRecovery, "PROHIBITED");
      assert.equal(finding.readOnly, true);
      assert.equal(finding.createsRecoveryTask, false);
      assert.equal(finding.task, null);
      assert.equal(Object.prototype.hasOwnProperty.call(finding, "correctionQuantity"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(finding, "repair"), false);
    }
  });

  it("CLS-05 shortage is a report-only observation with no correction quantity", () => {
    const report = classify({
      order: makeOrder(),
      reservation: makeReservation({
        items: [
          {
            inventoryItemId: ITEM_ID,
            requiredQuantity: 2,
            reservedQuantity: 0,
            shortageQuantity: 1,
            consumedQuantity: 1,
          },
        ],
        approval: {
          approvedAt: T1,
          requirementFingerprint: FP,
          shortageFingerprint: FP,
          shortages: [{ inventoryItemId: ITEM_ID, quantity: 1 }],
        },
      }),
      movements: [makeMovement({ quantity: 1, idempotencyKey: `sale:${ORDER_ID.$oid}:${ITEM_ID.$oid}` })],
      inventory: [makeInventory({ currentStock: 10, reservedStock: 0 })],
    });
    const shortage = report.findings.find((finding) => finding.code === "APPROVED_SHORTAGE");
    assert.ok(shortage);
    assert.equal(shortage.severity, "INFO");
    assert.equal(shortage.evidence.shortageQuantity, 1);
    assert.equal(shortage.evidence.consumedQuantity, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(shortage, "correctionQuantity"), false);
  });

  it("CLS-06 output is stable across repeats and key-order permutations", () => {
    const raw = {
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    };
    const first = classify(raw, { now: T2 });
    const second = classify(raw, { now: T2 });
    assert.equal(JSON.stringify(first), JSON.stringify(second));

    const permuted = classify(reverseKeys(raw), { now: T2 });
    assert.equal(JSON.stringify(permuted.summary), JSON.stringify(first.summary));
    assert.equal(JSON.stringify(permuted.findings), JSON.stringify(first.findings));
    assert.equal(JSON.stringify(permuted.deferred), JSON.stringify(first.deferred));
  });
});

describe("WP04-03 classifier lifecycle, determinism and safety (CLS)", () => {
  it("CLS-07 equivalent evidence has an identical fingerprint; material change differs", () => {
    const base = {
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    };
    const left = project(base);
    const right = project({
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    assert.equal(fingerprintEvidence(left).digest, fingerprintEvidence(right).digest);

    const changed = project({
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement({ quantity: 3 })],
      inventory: [makeInventory()],
    });
    assert.notEqual(fingerprintEvidence(left).digest, fingerprintEvidence(changed).digest);

    const reportA = classifyEvidence(left);
    const reportB = classifyEvidence(changed);
    if (reportA.findings.length > 0 && reportB.findings.length > 0) {
      assert.notEqual(reportA.findings[0].evidenceFingerprint, reportB.findings[0].evidenceFingerprint);
    }
  });

  it("CLS-08 lifecycle exclusions hold for clean consumption, valid void, approved shortage and inventory-free orders", () => {
    const clean = classify({
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    assert.equal(clean.findings.filter((f) => f.classification === "DEFECT").length, 0);

    const voided = classify({
      order: makeOrder({ status: "CANCELLED" }),
      reservation: makeReservation({
        status: "CONSUMED",
        voids: [
          {
            at: T1,
            phase: "POST_CONSUMPTION",
            source: "ORDER",
            lineId: null,
            station: null,
            items: [{ inventoryItemId: ITEM_ID, quantity: 2 }],
          },
        ],
      }),
      movements: [
        makeMovement({
          reason: "Waste",
          voidedAt: T1,
          voidReason: "order cancelled",
        }),
      ],
      inventory: [makeInventory()],
    });
    assert.equal(voided.findings.filter((f) => f.rule === "D08").length, 0);
    assert.equal(voided.findings.filter((f) => f.rule === "D02").length, 0);

    const shortage = classify({
      order: makeOrder(),
      reservation: makeReservation({
        items: [
          {
            inventoryItemId: ITEM_ID,
            requiredQuantity: 3,
            reservedQuantity: 0,
            shortageQuantity: 1,
            consumedQuantity: 2,
          },
        ],
        approval: {
          approvedAt: T1,
          requirementFingerprint: FP,
          shortageFingerprint: FP,
          shortages: [{ inventoryItemId: ITEM_ID, quantity: 1 }],
        },
      }),
      movements: [makeMovement({ quantity: 2 })],
      inventory: [makeInventory()],
    });
    assert.equal(shortage.findings.filter((f) => f.classification === "DEFECT").length, 0);

    const inventoryFree = classify({
      order: makeOrder({ items: [] }),
      reservation: null,
      movements: [],
      inventory: [],
    });
    assert.deepEqual(codesOf(inventoryFree, "D01"), ["NO_INVENTORY_REQUIREMENT"]);
    assert.equal(inventoryFree.findings[0].classification, "INFO");
  });

  it("CLS-09 PAID + RELEASED(CONSUMPTION_FAILED) + no movement yields D01, not D02", () => {
    const report = classify({
      order: makeOrder(),
      reservation: makeReservation({
        status: "RELEASED",
        releaseReason: "CONSUMPTION_FAILED",
        items: [
          {
            inventoryItemId: ITEM_ID,
            requiredQuantity: 2,
            reservedQuantity: 0,
            shortageQuantity: 0,
            consumedQuantity: 0,
          },
        ],
      }),
      movements: [],
      inventory: [makeInventory()],
    });
    assert.deepEqual(codesOf(report, "D01"), ["PAID_RELEASED_NO_DEDUCTION"]);
    assert.deepEqual(codesOf(report, "D02"), []);
  });

  it("CLS-10 a CONSUMING fixture without an approved threshold yields an alert, not a task", () => {
    const report = classify({
      order: makeOrder({ status: "PREPARING" }),
      reservation: makeReservation({
        status: "CONSUMING",
        consumedAt: null,
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
      movements: [],
      inventory: [makeInventory({ reservedStock: 2 })],
    });
    const alerts = report.findings.filter((finding) => finding.rule === "D06");
    assert.ok(alerts.length > 0);
    assert.ok(alerts.every((finding) => finding.classification === "ALERT"));
    assert.ok(alerts.every((finding) => finding.task === null));
    assert.ok(report.deferred.some((entry) => entry.rule === "D06"));
  });

  it("CLS-11 output contains no account number, holder name, item name or free-text reason", () => {
    const report = classify({
      order: makeOrder({ status: "CANCELLED" }),
      reservation: makeReservation({
        status: "CONSUMED",
        releaseReason: "CONSUMPTION_FAILED",
        voids: [],
      }),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("1234567890"), false);
    assert.equal(serialized.includes("Jane Doe"), false);
    assert.equal(serialized.includes("Secret Dish"), false);
    assert.equal(serialized.includes("order cancelled"), false);
  });

  it("CLS-12 the classifier source performs no I/O and exposes no write surface", () => {
    assert.equal(/mongoose|mongodb|node:fs|node:net|node:http|process\.env|Date\.now|Math\.random|fetch\(/.test(CLASSIFIER_SOURCE), false);
    assert.equal(typeof classifyEvidence.findBounded, "undefined");
    assert.ok(classifyEvidence.length <= 2);
    assert.equal(/"insertOne"|"updateOne"|"deleteOne"|"bulkWrite"|"createIndex"/.test(CLASSIFIER_SOURCE), false);
  });
});

describe("WP04-03 D01-D10 classification", () => {
  it("D01 reports a PAID order released without deduction", () => {
    const report = classify({
      order: makeOrder(),
      reservation: makeReservation({
        status: "RELEASED",
        releaseReason: "CONSUMPTION_FAILED",
        items: [
          {
            inventoryItemId: ITEM_ID,
            requiredQuantity: 2,
            reservedQuantity: 0,
            shortageQuantity: 0,
            consumedQuantity: 0,
          },
        ],
      }),
      movements: [],
      inventory: [makeInventory()],
    });
    assert.deepEqual(codesOf(report, "D01"), ["PAID_RELEASED_NO_DEDUCTION"]);
    assert.equal(report.findings[0].severity, "CRITICAL");
  });

  it("D02 reports a terminal deduction with no void and an orphan deduction", () => {
    const terminal = classify({
      order: makeOrder({ status: "CANCELLED" }),
      reservation: makeReservation({ status: "RELEASED", releaseReason: "CANCELLED" }),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(terminal, "D02").includes("TERMINAL_DEDUCTION_NO_VOID"));

    const orphan = classifyEvidence(
      projectEvidence({ order: null, reservation: null, movements: [makeMovement()], inventory: [makeInventory()] }),
    );
    assert.deepEqual(codesOf(orphan, "D02"), ["ORPHAN_DEDUCTION"]);
  });

  it("D03 reports duplicate identity, duplicate sale key and malformed sale key", () => {
    const duplicate = classify({
      order: makeOrder(),
      reservation: makeReservation({
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
      movements: [
        makeMovement(),
        makeMovement({ _id: MOV2_ID, quantity: 2 }),
      ],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(duplicate, "D03").includes("DUPLICATE_MOVEMENT_IDENTITY"));
    assert.ok(codesOf(duplicate, "D03").includes("DUPLICATE_IDEMPOTENCY_KEY"));
    assert.ok(codesOf(duplicate, "D03").includes("INDEX_ABSENT_SUSPECTED"));

    const malformed = classify({
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement({ idempotencyKey: "sale:wrong:key" })],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(malformed, "D03").includes("MALFORMED_SALE_KEY"));
  });

  it("D04 reports duplicate reservations and structural contradictions", () => {
    const duplicate = classifyBundles([
      bundle({
        order: makeOrder(),
        reservation: makeReservation(),
        movements: [makeMovement()],
        inventory: [makeInventory()],
      }),
      bundle({
        order: makeOrder(),
        reservation: makeReservation({ _id: RES2_ID }),
        movements: [makeMovement()],
        inventory: [makeInventory()],
      }),
    ]);
    assert.ok(codesOf(duplicate, "D04").includes("DUPLICATE_RESERVATION"));

    const structural = classify({
      order: makeOrder(),
      reservation: makeReservation({ consumedAt: null, status: "CONSUMED" }),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(structural, "D04").includes("CONSUMED_WITHOUT_EVIDENCE"));

    const releasedHold = classify({
      order: makeOrder({ status: "READY" }),
      reservation: makeReservation({
        status: "RELEASED",
        items: [
          {
            inventoryItemId: ITEM_ID,
            requiredQuantity: 2,
            reservedQuantity: 1,
            shortageQuantity: 0,
            consumedQuantity: 0,
          },
        ],
      }),
      movements: [],
      inventory: [makeInventory({ reservedStock: 1 })],
    });
    assert.ok(codesOf(releasedHold, "D04").includes("RELEASED_WITH_HOLD"));
  });

  it("D05 reports a terminal hold and an orphan live hold", () => {
    const terminal = classify({
      order: makeOrder({ status: "CANCELLED" }),
      reservation: makeReservation({
        status: "RESERVED",
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
      movements: [],
      inventory: [makeInventory({ reservedStock: 2 })],
    });
    assert.ok(codesOf(terminal, "D05").includes("HOLD_ON_TERMINAL_ORDER"));

    const orphan = classifyEvidence(
      projectEvidence({
        order: null,
        reservation: makeReservation({
          status: "RESERVED",
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
        movements: [],
        inventory: [makeInventory({ reservedStock: 2 })],
      }),
    );
    assert.ok(codesOf(orphan, "D05").includes("ORPHAN_LIVE_HOLD"));
  });
});

describe("WP04-03 D06-D10 classification", () => {
  it("D06 reports the CONSUMING state without creating a task", () => {
    const report = classify({
      order: makeOrder({ status: "PREPARING" }),
      reservation: makeReservation({ status: "CONSUMING", consumedAt: null, consumedQuantity: 0 }),
      movements: [],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(report, "D06").length > 0);
    assert.ok(report.findings.filter((f) => f.rule === "D06").every((f) => f.task === null));
  });

  it("D07 reports consumed/movement mismatch and a movement without reservation item", () => {
    const mismatch = classify({
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement({ quantity: 1 })],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(mismatch, "D07").includes("CONSUMED_MOVEMENT_MISMATCH"));

    const extra = classify({
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [
        makeMovement(),
        makeMovement({
          _id: MOV2_ID,
          item: ITEM2_ID,
          idempotencyKey: `sale:${ORDER_ID.$oid}:${ITEM2_ID.$oid}`,
        }),
      ],
      inventory: [makeInventory(), makeInventory({ _id: ITEM2_ID, currentStock: 10, reservedStock: 0 })],
    });
    assert.ok(codesOf(extra, "D07").includes("MOVEMENT_WITHOUT_RESERVATION_ITEM"));
  });

  it("D08 reports cancellation/void contradictions", () => {
    const whole = classify({
      order: makeOrder({ status: "CANCELLED" }),
      reservation: makeReservation({ status: "CONSUMED" }),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(whole, "D08").includes("CANCELLED_NO_ORDER_VOID"));
    assert.ok(codesOf(whole, "D08").includes("CANCELLED_SALE_NOT_RECLASSIFIED"));

    const line = classify({
      order: makeOrder({
        status: "PAID",
        items: [
          {
            lineId: LINE_ID,
            type: "FOOD",
            quantity: 1,
            cancelled: true,
            components: [
              { componentId: null, kind: "INVENTORY", inventoryItemId: ITEM_ID, stockQuantity: 2 },
            ],
          },
        ],
      }),
      reservation: makeReservation({ status: "CONSUMED" }),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(line, "D08").includes("LINE_CANCEL_NO_VOID"));
  });

  it("D09 reports payment workflow contradictions", () => {
    const pending = classify({
      order: makeOrder({
        status: "PAYMENT_PENDING",
        paidAt: T1,
        paymentSubmittedAt: T0,
      }),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(pending, "D09").includes("PENDING_WITH_PAID_AT"));

    const paid = classify({
      order: makeOrder({ status: "PAID", paidAt: null }),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(paid, "D09").includes("PAID_WITHOUT_PAID_AT"));

    const prepared = classify({
      order: makeOrder({ status: "SERVED", preparingAt: T0 }),
      reservation: makeReservation({
        status: "RESERVED",
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
      movements: [],
      inventory: [makeInventory({ reservedStock: 2 })],
    });
    assert.ok(codesOf(prepared, "D09").includes("PREPARED_WITH_LIVE_HOLD"));
  });

  it("D10 reports schema, quantity, orphan and identity errors and gates other rules", () => {
    const unknown = classify({
      order: makeOrder({ status: "BOGUS" }),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    assert.deepEqual(codesOf(unknown, "D10"), ["UNKNOWN_ENUM"]);
    assert.deepEqual(codesOf(unknown, "D01"), []);

    const negative = classify({
      order: makeOrder(),
      reservation: makeReservation({
        items: [
          {
            inventoryItemId: ITEM_ID,
            requiredQuantity: 2,
            reservedQuantity: -1,
            shortageQuantity: 0,
            consumedQuantity: 0,
          },
        ],
      }),
      movements: [makeMovement({ quantity: 2 })],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(negative, "D10").includes("NEGATIVE_QUANTITY"));

    const outOfRange = classify({
      order: makeOrder(),
      reservation: makeReservation({
        items: [
          {
            inventoryItemId: ITEM_ID,
            requiredQuantity: 2,
            reservedQuantity: 0,
            shortageQuantity: 0,
            consumedQuantity: 3,
          },
        ],
      }),
      movements: [makeMovement({ quantity: 3 })],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(outOfRange, "D10").includes("QUANTITY_OUT_OF_RANGE"));

    const orphanReference = classify({
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement({ item: ITEM2_ID, idempotencyKey: `sale:${ORDER_ID.$oid}:${ITEM2_ID.$oid}` })],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(orphanReference, "D10").includes("ORPHAN_REFERENCE"));

    const identity = classify({
      order: makeOrder(),
      reservation: makeReservation({ orderNumber: "ORD-2" }),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    assert.ok(codesOf(identity, "D10").includes("IDENTITY_MISMATCH"));
  });

  it("D10 reports evidence drift against an injected expected fingerprint", () => {
    const evidence = project({
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    const report = classifyEvidence(evidence, {
      expectedFingerprints: { "order:o:0000000000000000000000a1": FP2 },
    });
    assert.deepEqual(codesOf(report, "D10"), ["EVIDENCE_DRIFT"]);
    assert.deepEqual(report.findings.filter((f) => f.rule !== "D10"), []);
  });
});

describe("WP04-03 malformed evidence and numeric/date/identifier safety", () => {
  it("rejects null, wrong schema, BigInt, V2 scaled quantities and Decimal128", () => {
    assert.throws(() => classifyEvidence(null), (error) => error instanceof ClassifierError && error.code === "INVALID_EVIDENCE");
    assert.throws(
      () => classifyEvidence({ schema: "wp04-evidence-v2" }),
      (error) => error.code === "UNSUPPORTED_EVIDENCE_VERSION",
    );

    const base = project({
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    const bigintEvidence = structuredClone(base);
    bigintEvidence.movements[0].quantity = 1n;
    assert.throws(
      () => classifyEvidence(bigintEvidence),
      (error) => error.code === "UNSUPPORTED_V2_EVIDENCE",
    );

    const scaledEvidence = structuredClone(base);
    scaledEvidence.movements[0].quantity = { scaled: 1n };
    assert.throws(
      () => classifyEvidence(scaledEvidence),
      (error) => error.code === "UNSUPPORTED_V2_EVIDENCE",
    );

    const decimalEvidence = structuredClone(base);
    decimalEvidence.movements[0].quantity = { _bsontype: "Decimal128" };
    assert.throws(
      () => classifyEvidence(decimalEvidence),
      (error) => error.code === "UNSUPPORTED_NUMERIC_TYPE",
    );
  });

  it("rejects ambiguous identifiers, non-ISO dates and numeric strings", () => {
    const base = project({
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });

    const badId = structuredClone(base);
    badId.order.id = { $oid: "not-hex" };
    assert.throws(() => classifyEvidence(badId), (error) => error.code === "INVALID_IDENTIFIER");

    const emptyId = structuredClone(base);
    emptyId.order.id = "";
    assert.throws(() => classifyEvidence(emptyId), (error) => error.code === "INVALID_IDENTIFIER");

    const badDate = structuredClone(base);
    badDate.order.paidAt = "2026-11-08 10:00:00";
    assert.throws(() => classifyEvidence(badDate), (error) => error.code === "INVALID_DATE");

    const offsetDate = structuredClone(base);
    offsetDate.order.paidAt = "2026-11-08T10:00:00.000+03:00";
    assert.throws(() => classifyEvidence(offsetDate), (error) => error.code === "INVALID_DATE");

    const numericString = structuredClone(base);
    numericString.movements[0].quantity = "2";
    assert.throws(
      () => classifyEvidence(numericString),
      (error) => error.code === "INVALID_NUMERIC_VALUE",
    );

    assert.throws(
      () => classifyEvidence(base, { now: "not-a-date" }),
      (error) => error.code === "INVALID_DATE",
    );
  });

  it("preserves exact finite numeric semantics without rounding", () => {
    const report = classify({
      order: makeOrder(),
      reservation: makeReservation({
        items: [
          {
            inventoryItemId: ITEM_ID,
            requiredQuantity: 2.0001,
            reservedQuantity: 0,
            shortageQuantity: 0,
            consumedQuantity: 2.0001,
          },
        ],
      }),
      movements: [makeMovement({ quantity: 2 })],
      inventory: [makeInventory()],
    });
    const finding = report.findings.find(
      (entry) => entry.rule === "D07" && entry.code === "CONSUMED_MOVEMENT_MISMATCH",
    );
    assert.ok(finding);
    assert.equal(finding.evidence.consumedQuantity, 2.0001);
    assert.equal(finding.evidence.movementQuantity, 2);
  });

  it("enforces classifier bundle and finding bounds", () => {
    const evidence = project({
      order: makeOrder({ status: "CANCELLED" }),
      reservation: makeReservation({ status: "CONSUMED" }),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    assert.throws(
      () => classifyBundles([evidence, evidence], { maxBundles: 1 }),
      (error) => error.code === "EVIDENCE_BOUND_EXCEEDED",
    );
    assert.throws(
      () => classifyBundles([evidence], { maxFindings: 1 }),
      (error) => error.code === "EVIDENCE_BOUND_EXCEEDED",
    );
  });

  it("returns frozen output and does not mutate the input evidence", () => {
    const evidence = project({
      order: makeOrder(),
      reservation: makeReservation(),
      movements: [makeMovement()],
      inventory: [makeInventory()],
    });
    const before = JSON.stringify(evidence);
    const report = classifyEvidence(evidence);
    assert.equal(JSON.stringify(evidence), before);
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.findings), true);
    if (report.findings.length > 0) {
      assert.equal(Object.isFrozen(report.findings[0]), true);
      assert.throws(() => {
        "use strict";
        report.findings[0].code = "MUTATED";
      }, TypeError);
    }
  });
});





