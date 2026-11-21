// WP04-01 — focused, DB-free tests for the rule registry, evidence projection,
// and deterministic fingerprint.
//
// No MongoDB connection is opened. No environment file is read. The only
// filesystem use is reading the module sources for a read-only source contract.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RULES,
  RULES_BY_ID,
  RULE_IDS,
  ORDER_STATUSES,
  RESERVATION_STATUSES,
  SEVERITY,
  CONFIDENCE,
  EVIDENCE_LEVELS,
  TASK_CREATION_POLICY,
  getRuleDefinition,
  getReferencedRecoveryClasses,
} from "../lib/recovery/rules/registry.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  PROJECTION_LIMITS,
  EvidenceProjectionError,
  projectEvidence,
  tryProjectEvidence,
  normalizeIdentifier,
  normalizeDate,
  normalizeQuantity,
} from "../lib/recovery/evidence.js";
import {
  FINGERPRINT_VERSION,
  FingerprintError,
  canonicalize,
  toFingerprintPayload,
  canonicalizeFingerprintPayload,
  fingerprintEvidence,
} from "../lib/recovery/fingerprint.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (path) => readFileSync(join(root, path), "utf8");

const OID = {
  order: "64b000000000000000000001",
  line: "64b000000000000000000002",
  component: "64b000000000000000000003",
  item: "64b000000000000000000004",
  reservation: "64b000000000000000000005",
  movement: "64b000000000000000000006",
  movement2: "64b000000000000000000007",
};

function baseInput(overrides = {}) {
  const input = {
    order: {
      _id: OID.order,
      orderNumber: "ORD-1001",
      status: "PAID",
      paidAt: "2026-11-08T10:00:00.000Z",
      paymentMethod: "CASH",
      paymentAccountId: null,
      paymentAccountSnapshot: {
        accountNumber: "1234567890123456",
        holder: "Sensitive Holder",
      },
      paymentSubmittedAt: null,
      paymentSubmittedBy: null,
      paymentVerifiedAt: null,
      paymentVerifiedBy: null,
      paymentRejectedAt: null,
      paymentRejectedBy: null,
      paymentRejectionReason: "free text that must not appear",
      preparingAt: "2026-11-08T09:00:00.000Z",
      readyAt: "2026-11-08T09:30:00.000Z",
      servedAt: null,
      createdAt: "2026-11-08T08:00:00.000Z",
      updatedAt: "2026-11-08T10:00:00.000Z",
      kitchenStatus: "READY",
      baristaStatus: null,
      hotDrinkStatus: null,
      items: [
        {
          lineId: OID.line,
          type: "FOOD",
          quantity: 1,
          cancelled: false,
          cancelledAt: null,
          components: [
            {
              componentId: OID.component,
              kind: "PRICED_COMPONENT",
              inventoryItemId: OID.item,
              stockQuantity: 2,
            },
          ],
        },
      ],
    },
    reservation: {
      _id: OID.reservation,
      orderId: OID.order,
      orderNumber: "ORD-1001",
      status: "CONSUMED",
      requirementFingerprint: "req-fp",
      shortageFingerprint: null,
      items: [
        {
          inventoryItemId: OID.item,
          requiredQuantity: 2,
          reservedQuantity: 2,
          shortageQuantity: 0,
          consumedQuantity: 2,
        },
      ],
      approval: null,
      consumedAt: "2026-11-08T09:05:00.000Z",
      consumedTrigger: "PAYMENT",
      releasedAt: null,
      releaseReason: null,
      voids: [],
    },
    movements: [
      {
        _id: OID.movement,
        refOrderId: OID.order,
        item: OID.item,
        type: "OUT",
        quantity: 2,
        reason: "SaleDeduction",
        idempotencyKey: `sale:${OID.order}:${OID.item}`,
        voidedAt: null,
        voidReason: null,
        createdAt: "2026-11-08T09:05:00.000Z",
      },
    ],
    inventory: [
      {
        _id: OID.item,
        name: "Test Item",
        unit: "kg",
        currentStock: 10,
        reservedStock: 0,
      },
    ],
  };

  return { ...input, ...overrides };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertProjectionError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof EvidenceProjectionError, "expected EvidenceProjectionError");
    assert.equal(error.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
// A. Rule registry
// ---------------------------------------------------------------------------

describe("WP04-01 rule registry", () => {
  test("contains exactly D01–D10 in order", () => {
    assert.deepEqual([...RULE_IDS], [
      "D01",
      "D02",
      "D03",
      "D04",
      "D05",
      "D06",
      "D07",
      "D08",
      "D09",
      "D10",
    ]);
    assert.equal(RULES.length, 10);
    assert.equal(Object.keys(RULES_BY_ID).length, 10);
  });

  test("every rule has the required metadata and read-only posture", () => {
    const validSeverity = new Set(Object.values(SEVERITY));
    const validConfidence = new Set(Object.values(CONFIDENCE));
    const validEvidence = new Set(EVIDENCE_LEVELS);

    for (const rule of RULES) {
      assert.match(rule.id, /^D(0[1-9]|10)$/);
      assert.equal(typeof rule.title, "string");
      assert.ok(rule.title.length > 0);
      assert.equal(typeof rule.description, "string");
      assert.ok(rule.description.length > 0);
      assert.equal(rule.readOnly, true);
      assert.equal(rule.autoRecovery, "PROHIBITED");
      assert.equal(rule.createsRecoveryTask, false);
      assert.equal(rule.humanReview.required, true);
      assert.equal(rule.humanReview.independentVerification, true);
      assert.ok(rule.humanReview.roles.length > 0);
      assert.ok(rule.falsePositiveExclusions.length > 0);
      assert.ok(rule.subCodes.length > 0);
      assert.ok(rule.evidenceLevels.length > 0);
      assert.ok(rule.evidenceLevels.every((level) => validEvidence.has(level)));
      assert.ok(validSeverity.has(rule.severity.level));
      assert.ok(validSeverity.has(rule.severity.min));
      assert.ok(validSeverity.has(rule.severity.max));
      assert.ok(validConfidence.has(rule.confidence.level));
      assert.ok(validConfidence.has(rule.confidence.min));
      assert.ok(validConfidence.has(rule.confidence.max));
      assert.ok(
        [TASK_CREATION_POLICY.DEFERRED, TASK_CREATION_POLICY.ALERT_ONLY].includes(
          rule.taskCreationPolicy,
        ),
      );
    }
  });

  test("never references R9 or R10", () => {
    for (const rule of RULES) {
      assert.equal(rule.recoveryMap.includes("R9"), false);
      assert.equal(rule.recoveryMap.includes("R10"), false);
      assert.ok(rule.recoveryMap.length > 0);
      assert.ok(rule.recoveryMap.every((code) => /^R[1-8]$/.test(code)));
    }
    const referenced = getReferencedRecoveryClasses();
    assert.equal(referenced.includes("R9"), false);
    assert.equal(referenced.includes("R10"), false);
    assert.deepEqual([...referenced], ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);
  });

  test("D02 and D09 remain finding codes, not durable classes", () => {
    for (const id of ["D02", "D09"]) {
      const rule = getRuleDefinition(id);
      assert.equal(rule.findingCodeOnly, true);
      assert.equal(rule.durableClass, false);
      assert.equal(rule.taskCreationPolicy, TASK_CREATION_POLICY.DEFERRED);
    }
  });

  test("D06 is alert-only and creates no recovery task", () => {
    const d06 = getRuleDefinition("D06");
    assert.equal(d06.taskCreationPolicy, TASK_CREATION_POLICY.ALERT_ONLY);
    assert.equal(d06.createsRecoveryTask, false);
    assert.deepEqual([...d06.lifecycle.reservationStatuses], ["CONSUMING"]);
  });

  test("lifecycle statuses use known enums", () => {
    const orderEnums = new Set(ORDER_STATUSES);
    const reservationEnums = new Set([...RESERVATION_STATUSES, "ABSENT"]);

    for (const rule of RULES) {
      for (const status of rule.lifecycle.orderStatuses) {
        assert.ok(orderEnums.has(status), `${rule.id} unknown order status ${status}`);
      }
      for (const status of rule.lifecycle.reservationStatuses) {
        assert.ok(
          reservationEnums.has(status),
          `${rule.id} unknown reservation status ${status}`,
        );
      }
    }
  });

  test("sub-codes are unique within each rule", () => {
    for (const rule of RULES) {
      assert.equal(new Set(rule.subCodes).size, rule.subCodes.length, rule.id);
    }
  });

  test("registry and nested metadata are deeply frozen", () => {
    assert.equal(Object.isFrozen(RULES), true);
    assert.equal(Object.isFrozen(RULES[0]), true);
    assert.equal(Object.isFrozen(RULES[0].severity), true);
    assert.equal(Object.isFrozen(RULES[0].recoveryMap), true);
    assert.equal(Object.isFrozen(RULES[0].lifecycle.orderStatuses), true);
    assert.equal(Object.isFrozen(RULES_BY_ID), true);
    assert.throws(() => {
      RULES[0].severity.level = "LOW";
    }, TypeError);
    assert.throws(() => {
      RULES.push({});
    }, TypeError);
  });

  test("getRuleDefinition is total and cannot create rules", () => {
    assert.equal(getRuleDefinition("D01").id, "D01");
    assert.equal(getRuleDefinition("D11"), null);
    assert.equal(getRuleDefinition("R9"), null);
    assert.equal(getRuleDefinition("__proto__"), null);
    assert.equal(getRuleDefinition(null), null);
    assert.equal(getRuleDefinition({ id: "D01" }), null);
  });
});

// ---------------------------------------------------------------------------
// B. Evidence projection
// ---------------------------------------------------------------------------

describe("WP04-01 evidence projection", () => {
  test("projects only the allowlisted fields", () => {
    const projected = projectEvidence(baseInput());
    assert.equal(projected.schema, EVIDENCE_SCHEMA_VERSION);
    assert.equal(projected.order.status, "PAID");
    assert.equal(projected.order.items.length, 1);
    assert.deepEqual([...projected.order.cancelledLineIds], []);
    assert.equal(projected.reservation.status, "CONSUMED");
    assert.equal(projected.movements.length, 1);
    assert.equal(projected.inventory.length, 1);
    assert.equal(Object.isFrozen(projected), true);
    assert.equal(Object.isFrozen(projected.order), true);
    assert.equal(Object.isFrozen(projected.movements), true);

    const serialized = JSON.stringify(projected);
    assert.equal(serialized.includes("1234567890123456"), false);
    assert.equal(serialized.includes("Sensitive Holder"), false);
    assert.equal(serialized.includes("free text that must not appear"), false);
    assert.equal(serialized.includes("Test Item"), false);
    assert.equal(serialized.includes("accountNumber"), false);
    assert.equal(serialized.includes("_doc"), false);
  });

  test("recursively excludes sensitive keys at any depth", () => {
    const input = baseInput();
    input.order.pin = "1234";
    input.order.password = "secret";
    input.order.sessionToken = "token";
    input.order.items[0].authorization = "Bearer x";
    input.reservation.accountNumber = "9999999999999999";
    input.reservation.voids = [
      {
        at: "2026-11-08T11:00:00.000Z",
        source: "ORDER",
        lineId: null,
        station: "MANAGER",
        reason: "customer request",
        items: [{ inventoryItemId: OID.item, quantity: 2 }],
      },
    ];

    const projected = projectEvidence(input);
    const serialized = JSON.stringify(projected);
    for (const forbidden of [
      "1234",
      "secret",
      "Bearer x",
      "9999999999999999",
      "customer request",
      "pin",
      "password",
      "accountNumber",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  test("handles missing and null evidence explicitly", () => {
    const projected = projectEvidence({});
    assert.equal(projected.order, null);
    assert.equal(projected.reservation, null);
    assert.deepEqual([...projected.movements], []);
    assert.deepEqual([...projected.inventory], []);
    assert.equal(projected.projection.counts.orderItems, 0);
  });

  test("handles legacy orders with absent optional fields", () => {
    const projected = projectEvidence({
      order: { _id: OID.order, status: "PAID" },
    });
    assert.equal(projected.order.id, OID.order);
    assert.equal(projected.order.orderNumber, null);
    assert.equal(projected.order.paidAt, null);
    assert.equal(projected.order.paymentAccountSnapshotPresent, false);
    assert.deepEqual([...projected.order.items], []);
    assert.deepEqual([...projected.order.cancelledLineIds], []);
  });

  test("preserves exact numeric semantics without rounding", () => {
    const input = baseInput({
      reservation: {
        ...baseInput().reservation,
        items: [
          {
            inventoryItemId: OID.item,
            requiredQuantity: 0.1 + 0.2,
            reservedQuantity: 1 / 3,
            shortageQuantity: 0,
            consumedQuantity: 0.30000000000000004,
          },
        ],
      },
    });
    const projected = projectEvidence(input);
    const item = projected.reservation.items[0];
    assert.equal(item.requiredQuantity, 0.1 + 0.2);
    assert.equal(item.reservedQuantity, 1 / 3);
    assert.equal(item.consumedQuantity, 0.30000000000000004);
  });

  test("rejects numeric strings rather than coercing them", () => {
    const input = baseInput({
      reservation: {
        ...baseInput().reservation,
        items: [
          {
            inventoryItemId: OID.item,
            requiredQuantity: "2",
            reservedQuantity: 2,
            shortageQuantity: 0,
            consumedQuantity: 2,
          },
        ],
      },
    });
    assertProjectionError(() => projectEvidence(input), "INVALID_NUMERIC_VALUE");
  });

  test("rejects malformed input and invalid dates", () => {
    assertProjectionError(() => projectEvidence(null), "INVALID_INPUT");
    assertProjectionError(() => projectEvidence([]), "INVALID_INPUT");
    assertProjectionError(
      () => projectEvidence({ order: { status: "PAID", paidAt: "not-a-date" } }),
      "INVALID_DATE",
    );
    assertProjectionError(
      () => projectEvidence({ movements: [{ quantity: 1 }, null] }),
      "INVALID_MOVEMENT",
    );
  });

  test("preserves identifier type and rejects ambiguous identifiers", () => {
    assert.equal(normalizeIdentifier("123"), "123");
    assert.equal(normalizeIdentifier(123), 123);
    assert.deepEqual(
      normalizeIdentifier({ toHexString: () => OID.order }),
      { $oid: OID.order },
    );
    assert.equal(normalizeIdentifier(null), null);
    assert.throws(
      () => normalizeIdentifier({ toString: () => "[object Object]" }),
      EvidenceProjectionError,
    );
  });

  test("normalizes dates to ISO-8601 UTC", () => {
    assert.equal(normalizeDate("2026-11-08T10:00:00Z"), "2026-11-08T10:00:00.000Z");
    assert.equal(normalizeDate(new Date("2026-11-08T10:00:00Z")), "2026-11-08T10:00:00.000Z");
    assert.equal(normalizeDate(null), null);
    assert.throws(() => normalizeDate("nope"), EvidenceProjectionError);
  });

  test("normalizeQuantity preserves finite numbers and rejects others", () => {
    assert.equal(normalizeQuantity(100), 100);
    assert.equal(normalizeQuantity(100.0), 100);
    assert.equal(normalizeQuantity(null), null);
    assert.throws(() => normalizeQuantity(Number.NaN), EvidenceProjectionError);
    assert.throws(() => normalizeQuantity("100"), EvidenceProjectionError);
  });

  test("fails closed when a safety bound is exceeded", () => {
    const input = baseInput({
      movements: [baseInput().movements[0], baseInput().movements[0]],
    });
    assertProjectionError(
      () => projectEvidence(input, { limits: { maxMovements: 1 } }),
      "EVIDENCE_BOUND_EXCEEDED",
    );
    const projected = projectEvidence(baseInput(), { limits: { maxMovements: 5 } });
    assert.deepEqual(projected.projection.limits, {
      ...PROJECTION_LIMITS,
      maxMovements: 5,
    });
  });

  test("tryProjectEvidence returns a typed, redacted error", () => {
    const result = tryProjectEvidence({ movements: [{ quantity: "x" }] });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_NUMERIC_VALUE");
    assert.equal(result.error.message.includes("x"), false);
  });

  test("projection is deterministic for the same input", () => {
    const a = projectEvidence(clone(baseInput()));
    const b = projectEvidence(clone(baseInput()));
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// C. Fingerprint
// ---------------------------------------------------------------------------

describe("WP04-01 fingerprint", () => {
  test("produces a versioned 64-character SHA-256 digest", () => {
    const result = fingerprintEvidence(projectEvidence(baseInput()));
    assert.equal(result.version, FINGERPRINT_VERSION);
    assert.equal(result.algorithm, "sha256");
    assert.equal(result.schema, EVIDENCE_SCHEMA_VERSION);
    assert.match(result.digest, /^[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(result), true);
  });

  test("is stable across repeated projections", () => {
    const first = fingerprintEvidence(projectEvidence(clone(baseInput())));
    const second = fingerprintEvidence(projectEvidence(clone(baseInput())));
    assert.equal(first.digest, second.digest);
  });

  test("does not depend on source object key insertion order", () => {
    const input = baseInput();
    const reorderedOrder = {};
    for (const key of Object.keys(input.order).reverse()) {
      reorderedOrder[key] = input.order[key];
    }
    const reordered = { ...input, order: reorderedOrder };

    const first = fingerprintEvidence(projectEvidence(input));
    const second = fingerprintEvidence(projectEvidence(reordered));
    assert.equal(first.digest, second.digest);
  });

  test("canonicalizes 100 and 100.0 identically", () => {
    const integer = baseInput();
    integer.reservation.items[0].consumedQuantity = 100;
    const decimal = baseInput();
    decimal.reservation.items[0].consumedQuantity = 100.0;

    const a = fingerprintEvidence(projectEvidence(integer));
    const b = fingerprintEvidence(projectEvidence(decimal));
    assert.equal(a.digest, b.digest);
  });

  test("a changed consumed quantity changes the digest", () => {
    const changed = baseInput();
    changed.reservation.items[0].consumedQuantity = 3;
    const a = fingerprintEvidence(projectEvidence(baseInput()));
    const b = fingerprintEvidence(projectEvidence(changed));
    assert.notEqual(a.digest, b.digest);
  });

  test("account numbers and free-text reasons never enter the digest", () => {
    const changed = clone(baseInput());
    changed.order.paymentAccountSnapshot.accountNumber = "0000000000000000";
    changed.order.paymentRejectionReason = "different free text";
    changed.order.readyAt = "2026-11-08T09:45:00.000Z";
    changed.inventory[0].name = "Renamed item";
    changed.reservation.voids = [
      {
        at: "2026-11-08T11:00:00.000Z",
        source: "ORDER",
        lineId: null,
        reason: "free text A",
        items: [],
      },
    ];

    const base = clone(baseInput());
    base.reservation.voids = [
      {
        at: "2026-11-08T11:00:00.000Z",
        source: "ORDER",
        lineId: null,
        reason: "free text B",
        items: [],
      },
    ];

    const a = fingerprintEvidence(projectEvidence(base));
    const b = fingerprintEvidence(projectEvidence(changed));
    assert.equal(a.digest, b.digest);
  });

  test("a changed void timestamp changes the digest", () => {
    const changed = baseInput();
    changed.movements[0].voidedAt = "2026-11-08T12:00:00.000Z";
    const a = fingerprintEvidence(projectEvidence(baseInput()));
    const b = fingerprintEvidence(projectEvidence(changed));
    assert.notEqual(a.digest, b.digest);
  });

  test("a changed reservation void timestamp changes the digest", () => {
    const build = (at) => {
      const input = baseInput();
      input.reservation.voids = [
        {
          at,
          source: "ORDER",
          lineId: null,
          items: [{ inventoryItemId: OID.item, quantity: 2 }],
        },
      ];
      return input;
    };
    const a = fingerprintEvidence(projectEvidence(build("2026-11-08T11:00:00.000Z")));
    const b = fingerprintEvidence(projectEvidence(build("2026-11-08T11:00:01.000Z")));
    assert.notEqual(a.digest, b.digest);
  });

  test("movement and reservation-item order do not change the digest", () => {
    const input = baseInput();
    input.movements.push({
      _id: OID.movement2,
      refOrderId: OID.order,
      item: OID.item,
      type: "OUT",
      quantity: 1,
      reason: "Waste",
      idempotencyKey: null,
      voidedAt: null,
      voidReason: null,
      createdAt: "2026-11-08T09:06:00.000Z",
    });
    input.reservation.items.push({
      inventoryItemId: OID.item,
      requiredQuantity: 1,
      reservedQuantity: 1,
      shortageQuantity: 0,
      consumedQuantity: 1,
    });

    const reversed = clone(input);
    reversed.movements.reverse();
    reversed.reservation.items.reverse();

    const a = fingerprintEvidence(projectEvidence(input));
    const b = fingerprintEvidence(projectEvidence(reversed));
    assert.equal(a.digest, b.digest);
  });

  test("materially different evidence produces a different digest", () => {
    const changed = baseInput();
    changed.order.status = "CANCELLED";
    changed.reservation.items[0].reservedQuantity = 0;
    const a = fingerprintEvidence(projectEvidence(baseInput()));
    const b = fingerprintEvidence(projectEvidence(changed));
    assert.notEqual(a.digest, b.digest);
  });

  test("rejects an unsupported evidence schema version", () => {
    const projected = projectEvidence(baseInput());
    const tampered = { ...projected, schema: "wp04-evidence-v0" };
    assert.throws(
      () => fingerprintEvidence(tampered),
      (error) =>
        error instanceof FingerprintError &&
        error.code === "UNSUPPORTED_EVIDENCE_VERSION",
    );
  });

  test("canonical JSON sorts keys and handles null/undefined explicitly", () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalize({ a: undefined }), '{"a":null}');
    assert.equal(canonicalize([undefined, null]), "[null,null]");
    assert.equal(canonicalize(-0), "0");
    assert.equal(canonicalize("é"), JSON.stringify("é"));
  });

  test("rejects values that cannot be canonicalized", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, () => 1, new Date(), 1n]) {
      assert.throws(() => canonicalize(bad), FingerprintError);
    }
  });

  test("Unicode normalization is explicit: NFC and NFD remain distinct", () => {
    const nfc = "caf\u00e9";
    const nfd = "cafe\u0301";
    assert.equal(canonicalize(nfc), canonicalize(nfc));
    assert.notEqual(canonicalize(nfc), canonicalize(nfd));
  });

  test("the canonical payload excludes classification-only fields", () => {
    const projected = projectEvidence(baseInput());
    const payload = toFingerprintPayload(projected);
    assert.deepEqual(Object.keys(payload).sort(), [
      "inventory",
      "movements",
      "order",
      "reservation",
      "schema",
    ]);
    assert.equal("items" in payload.order, false);
    assert.equal("paymentSubmittedAt" in payload.order, false);
    assert.equal("approval" in payload.reservation, false);
    assert.equal("readyAt" in payload.order, false);
    assert.match(canonicalizeFingerprintPayload(projected), /^\{"inventory":/);
  });
});

// ---------------------------------------------------------------------------
// D. Read-only source contract and DB-free proof
// ---------------------------------------------------------------------------

describe("WP04-01 read-only source contract", () => {
  const modulePaths = [
    "lib/recovery/rules/registry.js",
    "lib/recovery/evidence.js",
    "lib/recovery/fingerprint.js",
  ];

  test("modules do not import a database, connection helper, or write service", () => {
    const forbiddenImports =
      /from\s+["'](?:mongoose|mongodb|@\/lib\/mongodb|@\/lib\/orderService|@\/lib\/inventoryReservationService|@\/lib\/inventoryDeductionService|@\/lib\/inventoryService|@\/lib\/inventoryReceiveService|@\/lib\/inventoryWasteService|@\/lib\/inventory-v2\/server[^"']*)["']/;

    for (const path of modulePaths) {
      const source = readSource(path);
      assert.equal(forbiddenImports.test(source), false, path);
      assert.equal(/require\s*\(/.test(source), false, path);
    }
  });

  test("modules contain no write method or index operation", () => {
    const forbiddenCalls =
      /\b(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|findOneAndReplace|findOneAndDelete|bulkWrite|createIndex|createIndexes|dropIndex|dropIndexes|syncIndexes|createCollection|dropCollection)\s*\(/;

    for (const path of modulePaths) {
      assert.equal(forbiddenCalls.test(readSource(path)), false, path);
    }
  });

  test("modules do not read environment, filesystem, network, or spawn processes", () => {
    const forbidden =
      /process\.env|readFileSync|writeFileSync|readFile\s*\(|writeFile\s*\(|node:fs|node:net|node:http|node:https|child_process|fetch\s*\(|\beval\s*\(|new\s+Function\s*\(/;

    for (const path of modulePaths) {
      assert.equal(forbidden.test(readSource(path)), false, path);
    }
  });

  test("modules do not reference Inventory V2 or V1 order-version fields", () => {
    const forbidden = /inventory_v2|inventoryMode|orderVersion/;
    for (const path of modulePaths) {
      assert.equal(forbidden.test(readSource(path)), false, path);
    }
  });

  test("the only runtime import is node:crypto and the local evidence schema", () => {
    const fingerprint = readSource("lib/recovery/fingerprint.js");
    const imports = [...fingerprint.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(imports.sort(), ["./evidence.js", "node:crypto"]);

    assert.equal(/from\s+["']/.test(readSource("lib/recovery/evidence.js")), false);
    assert.equal(/from\s+["']/.test(readSource("lib/recovery/rules/registry.js")), false);
  });

  test("no module exports a write-capable function", () => {
    const exportedFunctionNames = [];
    for (const path of modulePaths) {
      const source = readSource(path);
      for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) {
        exportedFunctionNames.push(match[1]);
      }
    }
    assert.deepEqual(exportedFunctionNames.sort(), [
      "canonicalize",
      "canonicalizeFingerprintPayload",
      "fingerprintEvidence",
      "getReferencedRecoveryClasses",
      "getRuleDefinition",
      "normalizeDate",
      "normalizeIdentifier",
      "normalizeQuantity",
      "projectEvidence",
      "toFingerprintPayload",
      "tryProjectEvidence",
    ]);
  });
});
