// BONO Inventory V2 — Phase 1 / Phase 1.2 pure-domain tests.
//
// DB-FREE ONLY: no MongoDB/Mongoose connection is opened, no environment file
// is read, and no application/API/model code is imported. The suite proves the
// deterministic identity, exact quantity arithmetic, accounting, state,
// approval, unit, waste, and payment rules in isolation.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

import {
  APPROVAL_CHALLENGE_TTL_MS,
  APPROVAL_EVIDENCE_VERSION,
  ALLOCATION_TUPLE_VERSION,
  ERROR_CODES,
  EXACT_QUANTITY_ERRORS,
  EXACT_QUANTITY_WIRE_VERSION,
  EXACT_SIGNED_QUANTITY_WIRE_VERSION,
  MAX_SCALED_QUANTITY,
  PAYMENT_EVIDENCE_ERRORS,
  STATE_EVIDENCE_ERRORS,
  WASTE_AUTHORIZATION_TTL_MS,
  WASTE_AUTHORIZATION_VERSION,
  applyWasteCorrection,
  archiveBeforePreparation,
  archivePreparedUnsold,
  assertAllocationIdentityConsistency,
  assertApprovalEvidence,
  assertUniqueAllocationIds,
  buildAllocationIdForKey,
  buildAllocationIdentity,
  buildAllocationKeyFromTuple,
  cancelPostStart,
  cancelPreStart,
  compareAllocationOrder,
  computeWasteAccounting,
  computeWasteCorrectionFingerprint,
  consumeApprovedShortage,
  consumeFull,
  convertQuantity,
  convertQuantityExact,
  convertQuantityForAccounting,
  deserializeExactQuantity,
  deserializeSignedExactQuantity,
  evaluateHighValue,
  evaluatePaymentReadiness,
  getConversionFactor,
  initialReservation,
  isPaymentReady,
  nextInventoryState,
  parseQuantityInUnit,
  reclassifyWaste,
  releaseHold,
  serializeExactQuantity,
  serializeSignedExactQuantity,
  sortAllocations,
  validateAllocationAccounting,
  validateApprovalSnapshot,
  validateQuantityRevision,
  validateTopUpEpoch,
  validateWasteCorrection,
  voidShortage,
  assertKdsReadyAllowed,
  hasActiveKdsTicket,
} from "../lib/inventory-v2/domain/index.js";

// P1-06: trusted-issuance helpers are intentionally not on the public barrel.
// Tests import them directly from their modules so the public surface can be
// asserted separately.
import { issueManagerActionAuthorization } from "../lib/inventory-v2/domain/approval.js";
import { issueWasteManagerAuthorization } from "../lib/inventory-v2/domain/waste.js";
import * as domainBarrel from "../lib/inventory-v2/domain/index.js";

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  });
}

function closeTo(actual, expected, epsilon = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

const BASE_IDENTITY = Object.freeze({
  orderId: "order-1",
  lineId: "line-1",
  station: "KITCHEN",
  inventoryItemId: "item-1",
  lineIndex: 1,
  componentIndex: 0,
  ingredientIndex: 0,
  occurrence: 0,
  canonicalUnit: "g",
});

function identity(overrides = {}) {
  return buildAllocationIdentity({ ...BASE_IDENTITY, ...overrides });
}

function accounting(overrides = {}) {
  return {
    requiredQuantity: 10,
    heldQuantity: 0,
    consumedQuantity: 0,
    releasedHoldQuantity: 0,
    voidedQuantity: 0,
    wasteQuantity: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Exact quantity arithmetic
// ---------------------------------------------------------------------------

describe("exact quantity arithmetic", () => {
  test("0.1 g round-trips through kg exactly", () => {
    const kg = convertQuantityExact(0.1, "g", "kg");
    assert.equal(kg.value, "0.0001");
    assert.equal(kg.scaled, 100_000n);

    const back = convertQuantityExact(kg.value, "kg", "g");
    assert.equal(back.value, "0.1");
    assert.equal(back.scaled, 100_000n);
  });

  test("0.4 g never becomes zero and 0.5 g never inflates to 1 g", () => {
    const four = convertQuantityExact(0.4, "g", "kg");
    assert.equal(four.value, "0.0004");
    assert.equal(four.scaled, 400_000n);
    assert.notEqual(four.scaled, 0n);

    const five = convertQuantityExact(0.5, "g", "kg");
    assert.equal(five.value, "0.0005");
    assert.equal(five.scaled, 500_000n);
    assert.notEqual(parseQuantityInUnit(five.value, "kg").scaled, 1_000_000n);
  });

  test("1.2345 g is preserved exactly", () => {
    const parsed = parseQuantityInUnit(1.2345, "g");
    assert.equal(parsed.scaled, 1_234_500n);
    assert.equal(convertQuantityExact(1.2345, "g", "kg").value, "0.0012345");
    assert.equal(convertQuantityExact(1.2345, "kg", "g").value, "1234.5");
  });

  test("repeated kg/g and L/ml conversions do not drift", () => {
    let value = "0.1";
    let unit = "g";
    let expected = 100_000n;
    for (let index = 0; index < 20; index += 1) {
      const target = unit === "g" ? "kg" : "g";
      const converted = convertQuantityExact(value, unit, target);
      assert.equal(converted.scaled, expected);
      value = converted.value;
      unit = target;
    }
    assert.equal(value, "0.1");
    assert.equal(unit, "g");

    let volume = "0.5";
    let volumeUnit = "ml";
    let volumeExpected = 500_000n;
    for (let index = 0; index < 20; index += 1) {
      const target = volumeUnit === "ml" ? "L" : "ml";
      const converted = convertQuantityExact(volume, volumeUnit, target);
      assert.equal(converted.scaled, volumeExpected);
      volume = converted.value;
      volumeUnit = target;
    }
    assert.equal(volume, "0.5");
    assert.equal(volumeUnit, "ml");
  });

  test("overflow, non-finite, and unsupported precision are rejected", () => {
    throwsCode(
      () => parseQuantityInUnit("100000001", "g"),
      EXACT_QUANTITY_ERRORS.QUANTITY_OUT_OF_RANGE
    );
    throwsCode(
      () => parseQuantityInUnit(Number.POSITIVE_INFINITY, "g"),
      ERROR_CODES.INVALID_QUANTITY
    );
    throwsCode(
      () => parseQuantityInUnit(Number.NaN, "g"),
      ERROR_CODES.INVALID_QUANTITY
    );
    throwsCode(
      () => parseQuantityInUnit(1.2345678, "g"),
      EXACT_QUANTITY_ERRORS.QUANTITY_PRECISION_UNSUPPORTED
    );
    throwsCode(
      () => parseQuantityInUnit("1e-7", "g"),
      EXACT_QUANTITY_ERRORS.QUANTITY_PRECISION_UNSUPPORTED
    );
    throwsCode(
      () => convertQuantityExact("100000001", "kg", "g"),
      EXACT_QUANTITY_ERRORS.QUANTITY_OUT_OF_RANGE
    );
  });

  test("sub-resolution accounting values cannot bypass the equation", () => {
    throwsCode(
      () =>
        validateAllocationAccounting({
          requiredQuantity: "0.0000001",
          heldQuantity: 0,
          consumedQuantity: 0,
        }),
      EXACT_QUANTITY_ERRORS.QUANTITY_PRECISION_UNSUPPORTED
    );
    throwsCode(
      () =>
        validateAllocationAccounting({
          requiredQuantity: 1,
          heldQuantity: 0.9999999,
          consumedQuantity: 0,
          shortageQuantity: 0,
        }),
      EXACT_QUANTITY_ERRORS.QUANTITY_PRECISION_UNSUPPORTED
    );
  });

  test("negative quantities are rejected, never clamped", () => {
    throwsCode(
      () => validateAllocationAccounting(accounting({ heldQuantity: -1 })),
      ERROR_CODES.NEGATIVE_QUANTITY
    );
    throwsCode(
      () =>
        initialReservation({
          requiredQuantity: 5,
          availableQuantity: -1,
        }),
      ERROR_CODES.NEGATIVE_QUANTITY
    );
    throwsCode(
      () => convertQuantity(-1, "kg", "g"),
      ERROR_CODES.NEGATIVE_QUANTITY
    );
  });

  test("0.1 + 0.2 validates exactly, unlike binary floating point", () => {
    const result = validateAllocationAccounting({
      requiredQuantity: 0.3,
      heldQuantity: 0.1,
      consumedQuantity: 0.2,
      releasedHoldQuantity: 0,
      voidedQuantity: 0,
      wasteQuantity: 0,
    });
    assert.equal(
      result.exact.heldQuantity + result.exact.consumedQuantity,
      result.exact.requiredQuantity
    );
    assert.equal(result.exact.shortageQuantity, 0n);
  });

  test("zero-required allocation is NOT_APPLICABLE and cannot be consumed", () => {
    const zero = initialReservation({
      requiredQuantity: 0,
      availableQuantity: 100,
    });
    assert.equal(zero.state, "NOT_APPLICABLE");
    assert.equal(zero.accounting.requiredQuantity, 0);
    throwsCode(
      () => consumeFull(zero.accounting),
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY
    );
  });

  test("zero-quantity movement is rejected", () => {
    const reserved = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 10,
    }).accounting;
    throwsCode(
      () => releaseHold(reserved, 0),
      ERROR_CODES.INVALID_QUANTITY
    );
    throwsCode(
      () => reclassifyWaste(consumeFull(reserved).accounting, { quantity: 0 }),
      ERROR_CODES.INVALID_QUANTITY
    );
  });

  test("exact quantity wire representation round-trips without loss", () => {
    const exact = parseQuantityInUnit("1.2345", "g");
    const wire = serializeExactQuantity(exact);
    assert.equal(wire.version, EXACT_QUANTITY_WIRE_VERSION);
    assert.deepEqual(
      {
        version: wire.version,
        unit: wire.unit,
        canonicalUnit: wire.canonicalUnit,
        scaled: wire.scaled,
      },
      {
        version: "quantity-wire-v1",
        unit: "g",
        canonicalUnit: "g",
        scaled: "1234500",
      }
    );
    const restored = deserializeExactQuantity(wire);
    assert.equal(restored.unit, "g");
    assert.equal(restored.canonicalUnit, "g");
    assert.equal(restored.scaled, 1_234_500n);
    assert.equal(restored.value, "1.2345");

    const zero = deserializeExactQuantity({
      version: EXACT_QUANTITY_WIRE_VERSION,
      unit: "pcs",
      canonicalUnit: "pcs",
      scaled: "0",
    });
    assert.equal(zero.scaled, 0n);

    const signed = serializeSignedExactQuantity({
      unit: "g",
      canonicalUnit: "g",
      scaled: -1_000_000n,
    });
    assert.equal(signed.version, EXACT_SIGNED_QUANTITY_WIRE_VERSION);
    assert.equal(signed.scaled, "-1000000");
    const restoredSigned = deserializeSignedExactQuantity(signed);
    assert.equal(restoredSigned.scaled, -1_000_000n);
    assert.equal(restoredSigned.value, "-1");
  });

  test("wire representation rejects lossy, malformed, mismatched, and negative physical values", () => {
    for (const scaled of [
      1.2345,
      "1.5",
      "0x10",
      "",
      " 1",
      "01",
      "1e6",
      "1.0",
      "abc",
      "+1",
      "-1",
    ]) {
      throwsCode(
        () =>
          deserializeExactQuantity({
            version: EXACT_QUANTITY_WIRE_VERSION,
            unit: "g",
            canonicalUnit: "g",
            scaled,
          }),
        ERROR_CODES.INVALID_QUANTITY
      );
    }
    throwsCode(
      () =>
        deserializeExactQuantity({
          version: EXACT_QUANTITY_WIRE_VERSION,
          unit: "g",
          canonicalUnit: "g",
          scaled: (MAX_SCALED_QUANTITY + 1n).toString(),
        }),
      EXACT_QUANTITY_ERRORS.QUANTITY_OUT_OF_RANGE
    );
    throwsCode(
      () =>
        deserializeExactQuantity({
          version: EXACT_QUANTITY_WIRE_VERSION,
          unit: "kg",
          canonicalUnit: "ml",
          scaled: "1",
        }),
      ERROR_CODES.INVALID_INPUT
    );
    throwsCode(
      () =>
        deserializeExactQuantity({
          version: EXACT_QUANTITY_WIRE_VERSION,
          unit: "g",
          canonicalUnit: "kg",
          scaled: "1",
        }),
      ERROR_CODES.UNKNOWN_UNIT
    );
    throwsCode(
      () =>
        serializeExactQuantity({
          unit: "g",
          canonicalUnit: "kg",
          scaled: 1n,
        }),
      ERROR_CODES.UNKNOWN_UNIT
    );
    throwsCode(
      () =>
        serializeExactQuantity({
          unit: "g",
          canonicalUnit: "g",
          scaled: -1n,
        }),
      ERROR_CODES.NEGATIVE_QUANTITY
    );
    throwsCode(
      () =>
        serializeExactQuantity({
          unit: "g",
          canonicalUnit: "g",
          scaled: Number.POSITIVE_INFINITY,
        }),
      ERROR_CODES.INVALID_QUANTITY
    );
  });

  test("wire version is mandatory and explicitly validated", () => {
    const wire = serializeExactQuantity(parseQuantityInUnit("1", "g"));
    for (const version of [undefined, null, "", "quantity-wire-v2"]) {
      throwsCode(
        () => deserializeExactQuantity({ ...wire, version }),
        ERROR_CODES.UNSUPPORTED_QUANTITY_WIRE_VERSION
      );
      throwsCode(
        () => deserializeSignedExactQuantity({ ...wire, version }),
        ERROR_CODES.UNSUPPORTED_QUANTITY_WIRE_VERSION
      );
    }
    // A physical wire payload cannot be accepted by the signed parser and
    // vice versa: the versions are distinct.
    throwsCode(
      () => deserializeSignedExactQuantity(wire),
      ERROR_CODES.UNSUPPORTED_QUANTITY_WIRE_VERSION
    );
    const signed = serializeSignedExactQuantity({
      unit: "g",
      canonicalUnit: "g",
      scaled: -1n,
    });
    throwsCode(
      () => deserializeExactQuantity(signed),
      ERROR_CODES.UNSUPPORTED_QUANTITY_WIRE_VERSION
    );
    assert.equal(
      deserializeExactQuantity({
        version: EXACT_QUANTITY_WIRE_VERSION,
        unit: "g",
        canonicalUnit: "g",
        scaled: MAX_SCALED_QUANTITY.toString(),
      }).scaled,
      MAX_SCALED_QUANTITY
    );
  });
});

// ---------------------------------------------------------------------------
// Canonical allocation identity v3
// ---------------------------------------------------------------------------

describe("allocation identity v3", () => {
  test("allocationKey and allocationId are deterministic", () => {
    const first = identity();
    const second = identity();
    assert.equal(first.allocationKey, second.allocationKey);
    assert.equal(first.allocationId, second.allocationId);
    assert.equal(first.version, ALLOCATION_TUPLE_VERSION);
    assert.match(first.allocationKey, /^alk_[0-9a-f]{64}$/);
    assert.match(first.allocationId, /^al_[0-9a-f]{64}$/);
  });

  test("identity matches an independent SHA-256 computation", () => {
    const result = identity();
    const tupleWithoutEpoch =
      "v3|order-1|line-1|KITCHEN|item-1|LINE_INDEX|1|1|0|0|0|g";
    const expectedKey =
      "alk_" +
      crypto
        .createHash("sha256")
        .update(tupleWithoutEpoch, "utf8")
        .digest("hex");
    const expectedId =
      "al_" +
      crypto
        .createHash("sha256")
        .update(`${expectedKey}|epoch=1`, "utf8")
        .digest("hex");

    assert.equal(result.canonicalTupleWithoutEpoch, tupleWithoutEpoch);
    assert.equal(result.canonicalTuple, `${tupleWithoutEpoch}|1`);
    assert.equal(result.allocationKey, expectedKey);
    assert.equal(result.allocationId, expectedId);
  });

  test("a new epoch changes allocationId but keeps allocationKey stable", () => {
    const epoch1 = identity({ epoch: 1 });
    const epoch2 = identity({ epoch: 2 });
    assert.equal(epoch1.allocationKey, epoch2.allocationKey);
    assert.notEqual(epoch1.allocationId, epoch2.allocationId);
  });

  test("componentId uses an explicit discriminator and still keeps lineIndex", () => {
    const result = identity({ componentId: "component-9", lineIndex: 4 });
    assert.equal(result.identityKind, "COMPONENT_ID");
    assert.equal(result.identityValue, "component-9");
    assert.equal(result.identityToken, "C:component-9");
    assert.equal(result.lineIndex, 4);
    assert.ok(
      result.canonicalTupleWithoutEpoch.includes(
        "|COMPONENT_ID|component-9|4|"
      )
    );
    assert.ok(!result.canonicalTupleWithoutEpoch.includes("|LINE_INDEX|"));
  });

  test("componentId line:1 cannot collide with line-index fallback", () => {
    const fallback = identity({ lineIndex: 1 });
    const component = identity({ lineIndex: 1, componentId: "line:1" });

    assert.notEqual(fallback.identityKind, component.identityKind);
    assert.notEqual(
      fallback.canonicalTupleWithoutEpoch,
      component.canonicalTupleWithoutEpoch
    );
    assert.notEqual(fallback.allocationKey, component.allocationKey);
    assert.notEqual(fallback.allocationId, component.allocationId);
  });

  test("different lineIndex values cannot collide", () => {
    const line1 = identity({ lineIndex: 1 });
    const line2 = identity({ lineIndex: 2 });
    assert.notEqual(line1.canonicalTupleWithoutEpoch, line2.canonicalTupleWithoutEpoch);
    assert.notEqual(line1.allocationId, line2.allocationId);
  });

  test("canonical units are strictly g/ml/pcs; kg and L are rejected", () => {
    assert.equal(identity({ canonicalUnit: "g" }).canonicalUnit, "g");
    assert.equal(identity({ canonicalUnit: "ml" }).canonicalUnit, "ml");
    assert.equal(identity({ canonicalUnit: "pcs" }).canonicalUnit, "pcs");
    for (const unit of ["kg", "L", "KG", "l", ""]) {
      throwsCode(
        () => identity({ canonicalUnit: unit }),
        ERROR_CODES.UNKNOWN_UNIT
      );
    }
  });

  test("delimiter and Unicode control characters are rejected", () => {
    throwsCode(
      () => identity({ lineId: "line|1" }),
      ERROR_CODES.INVALID_IDENTITY
    );
    throwsCode(
      () => identity({ lineId: "line\u00851" }),
      ERROR_CODES.INVALID_IDENTITY
    );
    throwsCode(
      () => identity({ inventoryItemId: "item\u009f" }),
      ERROR_CODES.INVALID_IDENTITY
    );
    throwsCode(
      () => identity({ inventoryItemId: "item\u0000" }),
      ERROR_CODES.INVALID_IDENTITY
    );
    throwsCode(
      () => identity({ inventoryItemId: "item\u202e" }),
      ERROR_CODES.INVALID_IDENTITY
    );
  });

  test("tampered tuple/key/id combinations fail consistency validation", () => {
    const original = identity();
    throwsCode(
      () =>
        assertAllocationIdentityConsistency({
          ...original,
          canonicalTupleWithoutEpoch: `${original.canonicalTupleWithoutEpoch}x`,
        }),
      ERROR_CODES.INVALID_IDENTITY
    );
    throwsCode(
      () =>
        assertAllocationIdentityConsistency({
          ...original,
          allocationKey: `alk_${"0".repeat(64)}`,
        }),
      ERROR_CODES.INVALID_IDENTITY
    );
    throwsCode(
      () =>
        assertAllocationIdentityConsistency({
          ...original,
          allocationId: "al_tampered",
        }),
      ERROR_CODES.INVALID_IDENTITY
    );
    throwsCode(
      () =>
        assertAllocationIdentityConsistency({
          ...original,
          orderId: "order-2",
        }),
      ERROR_CODES.INVALID_IDENTITY
    );
    for (const tampered of [
      { lineIndex: 9 },
      { identityToken: "LINE_INDEX" },
      { canonicalTuple: "v3|tampered" },
      { componentIndex: 4 },
      { occurrence: 2 },
      { canonicalUnit: "ml" },
    ]) {
      throwsCode(
        () =>
          assertAllocationIdentityConsistency({ ...original, ...tampered }),
        ERROR_CODES.INVALID_IDENTITY
      );
    }
  });

  test("malformed tuples are rejected", () => {
    throwsCode(
      () => buildAllocationKeyFromTuple("v2|order-1|line-1"),
      ERROR_CODES.INVALID_IDENTITY
    );
    throwsCode(
      () => buildAllocationKeyFromTuple(""),
      ERROR_CODES.INVALID_IDENTITY
    );
    throwsCode(
      () => buildAllocationKeyFromTuple("v3|order-1|\u0085"),
      ERROR_CODES.INVALID_IDENTITY
    );
  });

  test("same logical identity and epoch are deterministic", () => {
    const first = identity({ epoch: 3 });
    const second = identity({ epoch: 3 });
    assert.equal(first.canonicalTuple, second.canonicalTuple);
    assert.equal(first.allocationKey, second.allocationKey);
    assert.equal(first.allocationId, second.allocationId);
  });

  test("invalid identity inputs are rejected, never normalized", () => {
    throwsCode(() => buildAllocationIdentity({}), ERROR_CODES.INVALID_IDENTITY);
    throwsCode(() => identity({ orderId: "" }), ERROR_CODES.INVALID_IDENTITY);
    throwsCode(
      () => identity({ orderId: " order-1" }),
      ERROR_CODES.INVALID_IDENTITY
    );
    throwsCode(
      () => identity({ station: "kitchen" }),
      ERROR_CODES.UNKNOWN_STATION
    );
    throwsCode(() => identity({ lineIndex: -1 }), ERROR_CODES.INVALID_INPUT);
    throwsCode(
      () => identity({ componentIndex: 1.5 }),
      ERROR_CODES.INVALID_INPUT
    );
    throwsCode(() => identity({ occurrence: -1 }), ERROR_CODES.INVALID_INPUT);
    throwsCode(() => identity({ epoch: 0 }), ERROR_CODES.INVALID_INPUT);
    throwsCode(() => identity({ canonicalUnit: "" }), ERROR_CODES.UNKNOWN_UNIT);
  });

  test("same item on different lines and stations gets different IDs", () => {
    const line1 = identity({ lineIndex: 0, lineId: "line-a" });
    const line2 = identity({ lineIndex: 1, lineId: "line-b" });
    const barista = identity({ station: "BARISTA" });
    const hotDrink = identity({ station: "HOT_DRINK" });

    assert.notEqual(line1.allocationId, line2.allocationId);
    assert.notEqual(line1.allocationId, barista.allocationId);
    assert.notEqual(barista.allocationId, hotDrink.allocationId);
  });

  test("deterministic order is station, line, component, ingredient, item, occurrence, identity", () => {
    const rows = [
      identity({ station: "HOT_DRINK", lineIndex: 0, lineId: "h" }),
      identity({
        station: "KITCHEN",
        lineIndex: 2,
        lineId: "k2",
        inventoryItemId: "item-a",
      }),
      identity({
        station: "KITCHEN",
        lineIndex: 1,
        lineId: "k1b",
        inventoryItemId: "item-b",
      }),
      identity({
        station: "KITCHEN",
        lineIndex: 1,
        lineId: "k1a",
        inventoryItemId: "item-a",
        occurrence: 1,
      }),
      identity({
        station: "BARISTA",
        lineIndex: 0,
        lineId: "b",
      }),
      identity({
        station: "KITCHEN",
        lineIndex: 1,
        lineId: "k1a0",
        inventoryItemId: "item-a",
        occurrence: 0,
      }),
    ];

    const shuffled = [...rows].sort(() => 0.5 - Math.random());
    const sorted = sortAllocations(shuffled);
    assert.deepEqual(
      sorted.map((row) => row.lineId),
      ["k1a0", "k1a", "k1b", "k2", "b", "h"]
    );
    assert.equal(compareAllocationOrder(sorted[0], sorted[1]) < 0, true);
    assert.equal(compareAllocationOrder(sorted[1], sorted[0]) > 0, true);
  });

  test("component and fallback identities order deterministically", () => {
    const fallback = identity({ lineIndex: 3, lineId: "shared" });
    const component = identity({
      lineIndex: 3,
      lineId: "shared",
      componentId: "component-a",
    });
    const sorted = sortAllocations([fallback, component]);
    assert.equal(sorted[0].identityKind, "COMPONENT_ID");
    assert.equal(sorted[1].identityKind, "LINE_INDEX");
  });

  test("duplicate allocation IDs, key/epoch pairs, and tuples are rejected", () => {
    const a = identity();
    const b = identity({ lineId: "line-2", lineIndex: 2 });
    assert.equal(assertUniqueAllocationIds([a, b]), true);
    throwsCode(
      () => assertUniqueAllocationIds([a, { ...a }]),
      ERROR_CODES.DUPLICATE_ALLOCATION_ID
    );
    throwsCode(
      () => assertUniqueAllocationIds([{ ...a, allocationId: "al_tampered" }]),
      ERROR_CODES.INVALID_IDENTITY
    );
  });
});

// ---------------------------------------------------------------------------
// Accounting equation and transitions
// ---------------------------------------------------------------------------

const APPROVAL_NOW = 1_800_000_000_000;

function defaultHighValue(overrides = {}) {
  return evaluateHighValue({
    orderId: "order-1",
    policyVersion: "v2.1",
    actionActorId: "actor-1",
    evaluatedAt: APPROVAL_NOW - 1_000,
    orderTotalAmount: 50,
    thresholdAmount: 100,
    ...overrides,
  });
}

function consumptionApproval({
  requiredQuantity = 10,
  shortageQuantity = 4,
  allocationId = "al_consumption",
  orderId = "order-1",
  station = "KITCHEN",
  highValueEvaluation = defaultHighValue(),
} = {}) {
  const expected = {
    orderId,
    station,
    allocationIds: [allocationId],
    allocationQuantities: { [allocationId]: requiredQuantity },
    revision: 7,
    requirementFingerprint: `req-${allocationId}`,
    shortageFingerprint: `shortage-${allocationId}`,
    policyVersion: "v2.1",
    now: APPROVAL_NOW,
    currentActorId: "actor-1",
    orderTotalAmount: 50,
    thresholdAmount: 100,
    highValueEvaluation,
    allocationId,
    requiredQuantity,
    shortageQuantity,
  };
  const snapshot = {
    orderId,
    station,
    allocationIds: [allocationId],
    allocationQuantities: { [allocationId]: requiredQuantity },
    revision: 7,
    requirementFingerprint: `req-${allocationId}`,
    shortageFingerprint: `shortage-${allocationId}`,
    policyVersion: "v2.1",
    issuedAt: APPROVAL_NOW - 1_000,
    expiresAt: APPROVAL_NOW + 30_000,
    actionActorId: "actor-1",
    firstApproval: { stage: 1, managerId: "manager-1" },
    // Deliberately ignored; the trusted evaluation is supplied separately.
    highValue: { isHighValue: false },
  };
  return {
    evidence: validateApprovalSnapshot(snapshot, expected),
    expected,
    snapshot,
  };
}

// P1-08: shortage consumption is always bound to the exact allocation and
// authoritative required quantity.
function shortageConsumptionOptions(approval, overrides = {}) {
  return {
    approvalEvidence: approval.evidence,
    approvalExpected: approval.expected,
    allocationId: approval.expected.allocationId,
    requiredQuantity: approval.expected.requiredQuantity,
    ...overrides,
  };
}

function managerActionAuthorization({
  action = "TOP_UP",
  orderId = "order-1",
  station = "KITCHEN",
  allocationId = "al_consumption",
  epoch = 1,
  actorId = "actor-1",
  revision = 7,
  targetState = null,
  now = APPROVAL_NOW,
  ...overrides
} = {}) {
  const claim = {
    managerId: "manager-1",
    role: "MANAGER",
    authorizationId: `auth-${action}`,
    action,
    orderId,
    station,
    allocationId,
    epoch,
    actorId,
    revision,
    approved: true,
    issuedAt: now - 1_000,
    expiresAt: now + 30_000,
    ...(targetState ? { targetState } : {}),
    ...overrides,
  };
  return issueManagerActionAuthorization(
    claim,
    {
      action,
      orderId,
      station,
      allocationId,
      epoch,
      currentActorId: actorId,
      revision,
      ...(targetState ? { targetState } : {}),
      now,
    },
    { verifyManager: () => true }
  );
}

describe("accounting equation", () => {
  test("valid equation and derived shortage", () => {
    const result = validateAllocationAccounting(
      accounting({ requiredQuantity: 10, heldQuantity: 6, shortageQuantity: 4 })
    );
    assert.equal(result.shortageQuantity, 4);
    assert.equal(
      result.exact.requiredQuantity,
      result.exact.heldQuantity +
        result.exact.consumedQuantity +
        result.exact.releasedHoldQuantity +
        result.exact.voidedQuantity +
        result.exact.shortageQuantity
    );
  });

  test("invalid equation is rejected", () => {
    throwsCode(
      () =>
        validateAllocationAccounting(
          accounting({
            heldQuantity: 1,
            consumedQuantity: 1,
            releasedHoldQuantity: 1,
            voidedQuantity: 1,
            shortageQuantity: 7,
          })
        ),
      ERROR_CODES.EQUATION_MISMATCH
    );
  });

  test("over-consumption, over-release, and over-void are rejected", () => {
    throwsCode(
      () => validateAllocationAccounting(accounting({ consumedQuantity: 11 })),
      ERROR_CODES.OVER_CONSUMPTION
    );
    throwsCode(
      () =>
        releaseHold(
          accounting({
            requiredQuantity: 10,
            heldQuantity: 6,
            shortageQuantity: 4,
          }),
          7
        ),
      ERROR_CODES.OVER_RELEASE
    );
    throwsCode(
      () =>
        voidShortage(
          accounting({
            requiredQuantity: 10,
            heldQuantity: 6,
            shortageQuantity: 4,
          }),
          5
        ),
      ERROR_CODES.OVER_VOID
    );
  });

  test("waste greater than consumption is rejected", () => {
    throwsCode(
      () =>
        validateAllocationAccounting(
          accounting({ consumedQuantity: 10, wasteQuantity: 11 })
        ),
      ERROR_CODES.WASTE_EXCEEDS_CONSUMPTION
    );
  });
});

describe("accounting transitions", () => {
  test("initial reservation and full consumption preserve the equation", () => {
    const reserved = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 10,
    });
    assert.equal(reserved.state, "PENDING");
    assert.equal(reserved.accounting.heldQuantity, 10);
    assert.equal(reserved.accounting.shortageQuantity, 0);
    assert.equal(reserved.addedHoldQuantity, 10);

    const consumed = consumeFull(reserved.accounting);
    assert.equal(consumed.state, "CONSUMED");
    assert.equal(consumed.completionReason, "FULL");
    assert.deepEqual(consumed.accounting, {
      requiredQuantity: 10,
      heldQuantity: 0,
      consumedQuantity: 10,
      releasedHoldQuantity: 0,
      voidedQuantity: 0,
      shortageQuantity: 0,
      wasteQuantity: 0,
    });
    assert.equal(
      validateAllocationAccounting(consumed.accounting).shortageQuantity,
      0
    );
  });

  test("approved shortage consumes all held quantity and leaves S unfulfilled", () => {
    const reserved = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    });
    assert.equal(reserved.state, "APPROVAL_REQUIRED");
    assert.equal(reserved.accounting.heldQuantity, 6);
    assert.equal(reserved.accounting.shortageQuantity, 4);

    const approval = consumptionApproval({
      requiredQuantity: 10,
      shortageQuantity: 4,
    });
    const consumed = consumeApprovedShortage(
      reserved.accounting,
      shortageConsumptionOptions(approval)
    );
    assert.equal(consumed.state, "PARTIALLY_CONSUMED");
    assert.equal(consumed.completionReason, "APPROVED_SHORTAGE");
    assert.equal(consumed.accounting.heldQuantity, 0);
    assert.equal(consumed.accounting.consumedQuantity, 6);
    assert.equal(consumed.accounting.shortageQuantity, 4);
    assert.equal(
      consumed.accounting.consumedQuantity,
      6,
      "S must not be faked as C"
    );
  });

  test("approved shortage requires validated approval and a real shortage", () => {
    const shortage = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    }).accounting;
    throwsCode(
      () =>
        consumeApprovedShortage(shortage, {
          allocationId: "al_consumption",
          requiredQuantity: 10,
        }),
      ERROR_CODES.APPROVAL_REQUIRED
    );
    throwsCode(
      () =>
        consumeApprovedShortage(shortage, {
          allocationId: "al_consumption",
          requiredQuantity: 10,
          approvalValid: true,
        }),
      ERROR_CODES.APPROVAL_REQUIRED
    );

    const full = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 10,
    }).accounting;
    const approval = consumptionApproval({
      requiredQuantity: 10,
      shortageQuantity: 1,
    });
    throwsCode(
      () =>
        consumeApprovedShortage(
          full,
          shortageConsumptionOptions(approval)
        ),
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY
    );
  });

  test("boolean-only and copied approval evidence cannot authorize consumption", () => {
    const shortage = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    }).accounting;
    const approval = consumptionApproval();
    throwsCode(
      () =>
        consumeApprovedShortage(
          shortage,
          shortageConsumptionOptions(approval, {
            approvalEvidence: { ...approval.evidence, valid: true },
          })
        ),
      ERROR_CODES.APPROVAL_REQUIRED
    );
    throwsCode(
      () =>
        consumeApprovedShortage(
          shortage,
          shortageConsumptionOptions(approval, {
            approvalEvidence: { valid: true },
          })
        ),
      ERROR_CODES.APPROVAL_REQUIRED
    );
  });

  test("expired approval evidence cannot authorize consumption", () => {
    const shortage = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    }).accounting;
    const approval = consumptionApproval();
    const expiredExpected = {
      ...approval.expected,
      now: APPROVAL_NOW + 30_000,
    };
    throwsCode(
      () =>
        consumeApprovedShortage(
          shortage,
          shortageConsumptionOptions(approval, {
            approvalExpected: expiredExpected,
          })
        ),
      ERROR_CODES.APPROVAL_EXPIRED
    );
  });

  test("consumeApprovedShortage requires the expected shortage to match live accounting", () => {
    // Live accounting shortage is 4; the approval was bound to 1.
    const shortage = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    }).accounting;
    const staleApproval = consumptionApproval({ shortageQuantity: 1 });
    throwsCode(
      () =>
        consumeApprovedShortage(
          shortage,
          shortageConsumptionOptions(staleApproval)
        ),
      ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH
    );
    // Omitting the expected shortage fails closed; the live value is never
    // silently substituted.
    const full = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 10,
    }).accounting;
    const noShortageExpected = {
      ...staleApproval.expected,
      shortageQuantity: undefined,
    };
    throwsCode(
      () =>
        consumeApprovedShortage(
          shortage,
          shortageConsumptionOptions(staleApproval, {
            approvalExpected: noShortageExpected,
          })
        ),
      ERROR_CODES.INVALID_QUANTITY
    );
    throwsCode(
      () =>
        consumeApprovedShortage(full, {
          allocationId: "al_consumption",
          requiredQuantity: 10,
        }),
      ERROR_CODES.APPROVAL_REQUIRED
    );
  });

  test("pre-start cancellation returns exact holds and voids shortage", () => {
    const reserved = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    }).accounting;
    const cancelled = cancelPreStart(reserved);
    assert.equal(cancelled.state, "RELEASED");
    assert.equal(cancelled.accounting.heldQuantity, 0);
    assert.equal(cancelled.accounting.releasedHoldQuantity, 6);
    assert.equal(cancelled.accounting.voidedQuantity, 4);
    assert.equal(cancelled.accounting.shortageQuantity, 0);
    assert.equal(cancelled.accounting.consumedQuantity, 0);
    assert.equal(
      cancelled.accounting.releasedHoldQuantity +
        cancelled.accounting.voidedQuantity,
      10
    );
  });

  test("post-start cancellation never restores stock; consumed becomes waste", () => {
    const reserved = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    }).accounting;
    const approval = consumptionApproval();
    const consumed = consumeApprovedShortage(
      reserved,
      shortageConsumptionOptions(approval)
    ).accounting;
    const cancelled = cancelPostStart(consumed);

    assert.equal(cancelled.state, "RELEASED_PARTIAL");
    assert.equal(cancelled.accounting.consumedQuantity, 6);
    assert.equal(cancelled.accounting.wasteQuantity, 6);
    assert.equal(cancelled.accounting.voidedQuantity, 4);
    assert.equal(cancelled.accounting.shortageQuantity, 0);
    assert.equal(cancelled.wasteClass, "ORDER_LINKED");
    assert.equal(
      computeWasteAccounting({
        consumedQuantity: cancelled.accounting.consumedQuantity,
        orderLinkedWaste: cancelled.accounting.wasteQuantity,
      }).sold,
      0
    );
  });

  test("archive before preparation releases the hold", () => {
    const reserved = initialReservation({
      requiredQuantity: 4,
      availableQuantity: 4,
    }).accounting;
    const archived = archiveBeforePreparation(reserved);
    assert.equal(archived.state, "RELEASED");
    assert.equal(archived.accounting.releasedHoldQuantity, 4);
    assert.equal(archived.accounting.consumedQuantity, 0);
  });

  test("prepared-but-unsold archive contributes to W", () => {
    const consumed = consumeFull(
      initialReservation({
        requiredQuantity: 10,
        availableQuantity: 10,
      }).accounting
    ).accounting;
    const archived = archivePreparedUnsold(consumed);
    assert.equal(archived.state, "RELEASED_PARTIAL");
    assert.equal(archived.completionReason, "PREPARED_UNSOLD");
    assert.equal(archived.wasteClass, "PREPARED_UNSOLD");
    assert.equal(archived.accounting.wasteQuantity, 10);
    assert.equal(
      computeWasteAccounting({
        consumedQuantity: archived.accounting.consumedQuantity,
        orderLinkedWaste: archived.accounting.wasteQuantity,
      }).sold,
      0
    );
  });

  test("phase waste reclassification never changes Q/H/C/R/S", () => {
    const consumed = consumeFull(
      initialReservation({
        requiredQuantity: 10,
        availableQuantity: 10,
      }).accounting
    ).accounting;
    const reclassified = reclassifyWaste(consumed, {
      quantity: 4,
      wasteClass: "ORDER_LINKED",
    });
    assert.equal(reclassified.accounting.wasteQuantity, 4);
    assert.equal(reclassified.accounting.consumedQuantity, 10);
    assert.equal(reclassified.accounting.heldQuantity, 0);
    assert.equal(reclassified.accounting.shortageQuantity, 0);
    throwsCode(
      () =>
        reclassifyWaste(consumed, {
          quantity: 11,
          wasteClass: "ORDER_LINKED",
        }),
      ERROR_CODES.WASTE_EXCEEDS_CONSUMPTION
    );
  });

  test("top-up requires a new immutable epoch and a linked predecessor", () => {
    const current = identity({ epoch: 1 });
    const topUp = validateTopUpEpoch({
      state: "PARTIALLY_CONSUMED",
      currentEpoch: current.epoch,
      allocationKey: current.allocationKey,
      previousAllocationId: current.allocationId,
      nextEpoch: 2,
      newShortageQuantity: 2,
    });
    assert.equal(topUp.previousEpoch, 1);
    assert.equal(topUp.epoch, 2);
    assert.equal(topUp.allocationKey, current.allocationKey);
    assert.notEqual(topUp.allocationId, current.allocationId);
    assert.equal(topUp.reopenedFromAllocationId, current.allocationId);
    assert.equal(topUp.requiresFreshApproval, true);

    throwsCode(
      () =>
        validateTopUpEpoch({
          state: "CONSUMED",
          currentEpoch: 1,
          allocationKey: current.allocationKey,
          previousAllocationId: current.allocationId,
        }),
      ERROR_CODES.TOP_UP_FORBIDDEN
    );
    throwsCode(
      () =>
        validateTopUpEpoch({
          state: "PENDING",
          currentEpoch: 1,
          allocationKey: current.allocationKey,
          previousAllocationId: current.allocationId,
        }),
      ERROR_CODES.TOP_UP_NOT_ALLOWED
    );
    throwsCode(
      () =>
        validateTopUpEpoch({
          state: "PARTIALLY_CONSUMED",
          currentEpoch: 1,
          allocationKey: current.allocationKey,
          previousAllocationId: current.allocationId,
          nextEpoch: 3,
        }),
      ERROR_CODES.TOP_UP_EPOCH_INVALID
    );
    throwsCode(
      () =>
        validateTopUpEpoch({
          state: "PARTIALLY_CONSUMED",
          currentEpoch: 1,
          allocationKey: current.allocationKey,
          previousAllocationId: "al_wrong",
        }),
      ERROR_CODES.TOP_UP_PREDECESSOR_REQUIRED
    );
  });

  test("pre-consumption revisions keep the same epoch; post-consumption requires a new one", () => {
    const revision = validateQuantityRevision({
      epoch: 1,
      allocationId: "al_same",
      hasConsumptionMovement: false,
    });
    assert.equal(revision.epoch, 1);
    assert.equal(revision.isNewEpoch, false);
    assert.equal(revision.hasConsumptionMovement, false);

    throwsCode(
      () =>
        validateQuantityRevision({
          epoch: 1,
          allocationId: "al_same",
          hasConsumptionMovement: true,
        }),
      ERROR_CODES.NEW_EPOCH_REQUIRED
    );
  });

  test("quantity revision movement evidence is mandatory and fail-closed", () => {
    for (const value of [undefined, null, 0, 1, "false", "true", {}, []]) {
      throwsCode(
        () =>
          validateQuantityRevision({
            epoch: 1,
            allocationId: "al_same",
            hasConsumptionMovement: value,
          }),
        ERROR_CODES.QUANTITY_REVISION_EVIDENCE_REQUIRED
      );
    }
    throwsCode(
      () => validateQuantityRevision({ epoch: 1 }),
      ERROR_CODES.QUANTITY_REVISION_EVIDENCE_REQUIRED
    );
    throwsCode(
      () =>
        validateQuantityRevision({
          epoch: 1,
          allocationId: "",
          hasConsumptionMovement: false,
        }),
      ERROR_CODES.INVALID_IDENTITY
    );
    throwsCode(
      () =>
        validateQuantityRevision({
          epoch: 1,
          allocationId: " al_same",
          hasConsumptionMovement: false,
        }),
      ERROR_CODES.INVALID_IDENTITY
    );
  });

  test("every transition preserves Q = H + C + R_hold + R_void + S and 0 <= W <= C", () => {
    const full = consumeFull(
      initialReservation({ requiredQuantity: 10, availableQuantity: 10 })
        .accounting
    );
    const approval = consumptionApproval();
    const shortage = consumeApprovedShortage(
      initialReservation({ requiredQuantity: 10, availableQuantity: 6 })
        .accounting,
      shortageConsumptionOptions(approval)
    );
    const preCancel = cancelPreStart(
      initialReservation({ requiredQuantity: 10, availableQuantity: 6 })
        .accounting
    );
    const postCancel = cancelPostStart(shortage.accounting);
    const preparedUnsold = archivePreparedUnsold(full.accounting);

    for (const scenario of [
      full,
      shortage,
      preCancel,
      postCancel,
      preparedUnsold,
    ]) {
      const a = validateAllocationAccounting(scenario.accounting);
      const sum =
        a.exact.heldQuantity +
        a.exact.consumedQuantity +
        a.exact.releasedHoldQuantity +
        a.exact.voidedQuantity +
        a.exact.shortageQuantity;
      assert.equal(sum, a.exact.requiredQuantity);
      assert.ok(a.exact.wasteQuantity >= 0n);
      assert.ok(a.exact.wasteQuantity <= a.exact.consumedQuantity);
      assert.equal(a.requiredQuantity, 10);
    }
  });

  test("arbitrary partial consumption is not exposed and fails closed", () => {
    assert.equal("consumePartial" in globalThis, false);
    throwsCode(
      () => nextInventoryState("PENDING", "PARTIAL_CONSUME"),
      ERROR_CODES.PARTIAL_CONSUMPTION_DISABLED
    );

    const reserved = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 10,
    }).accounting;
    throwsCode(
      () => consumeFull(reserved, { quantity: 3 }),
      ERROR_CODES.PARTIAL_CONSUMPTION_DISABLED
    );
  });
});

// ---------------------------------------------------------------------------
// Inventory state machine
// ---------------------------------------------------------------------------

describe("inventory state machine", () => {
  test("line addition requires explicit shortage evidence", () => {
    assert.equal(
      nextInventoryState("NOT_APPLICABLE", "LINE_ADDED", {
        shortageQuantity: 0,
      }),
      "PENDING"
    );
    assert.equal(
      nextInventoryState("NOT_APPLICABLE", "LINE_ADDED", {
        shortageQuantity: 1,
      }),
      "APPROVAL_REQUIRED"
    );
    throwsCode(
      () => nextInventoryState("NOT_APPLICABLE", "LINE_ADDED"),
      STATE_EVIDENCE_ERRORS.ACCOUNTING_EVIDENCE_REQUIRED
    );
  });

  test("PENDING start requires full-hold accounting evidence", () => {
    const full = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 10,
    }).accounting;
    assert.equal(
      nextInventoryState("PENDING", "START", { accounting: full }),
      "CONSUMED"
    );
    throwsCode(
      () => nextInventoryState("PENDING", "START"),
      STATE_EVIDENCE_ERRORS.ACCOUNTING_EVIDENCE_REQUIRED
    );
    const shortage = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    }).accounting;
    throwsCode(
      () => nextInventoryState("PENDING", "START", { accounting: shortage }),
      STATE_EVIDENCE_ERRORS.FULL_HOLD_EVIDENCE_REQUIRED
    );
    throwsCode(
      () =>
        nextInventoryState("PENDING", "START", {
          shortageQuantity: 1,
        }),
      STATE_EVIDENCE_ERRORS.ACCOUNTING_EVIDENCE_REQUIRED
    );
  });

  test("APPROVED starts only with validated approval and a positive shortage", () => {
    const shortage = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    }).accounting;
    const approval = consumptionApproval({
      requiredQuantity: 10,
      shortageQuantity: 4,
    });

    throwsCode(
      () =>
        nextInventoryState("APPROVED", "START", {
          shortageQuantity: 4,
        }),
      ERROR_CODES.APPROVAL_REQUIRED
    );
    throwsCode(
      () =>
        nextInventoryState("APPROVED", "START", {
          accounting: shortage,
          approvalValid: true,
        }),
      ERROR_CODES.APPROVAL_REQUIRED
    );
    assert.equal(
      nextInventoryState("APPROVED", "START", {
        accounting: shortage,
        approvalEvidence: approval.evidence,
        approvalExpected: approval.expected,
      }),
      "PARTIALLY_CONSUMED"
    );

    const full = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 10,
    }).accounting;
    const noShortageApproval = consumptionApproval({
      requiredQuantity: 10,
      shortageQuantity: 1,
    });
    throwsCode(
      () =>
        nextInventoryState("APPROVED", "START", {
          accounting: full,
          approvalEvidence: noShortageApproval.evidence,
          approvalExpected: noShortageApproval.expected,
        }),
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY
    );
    assert.equal(
      nextInventoryState("APPROVED", "INVALIDATE_APPROVAL"),
      "APPROVAL_REQUIRED"
    );
  });

  test("APPROVAL_REQUIRED approve requires validated approval evidence", () => {
    const shortage = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    }).accounting;
    const approval = consumptionApproval();
    assert.equal(
      nextInventoryState("APPROVAL_REQUIRED", "APPROVE", {
        accounting: shortage,
        approvalEvidence: approval.evidence,
        approvalExpected: approval.expected,
      }),
      "APPROVED"
    );
    throwsCode(
      () =>
        nextInventoryState("APPROVAL_REQUIRED", "APPROVE", {
          accounting: shortage,
          approvalValid: true,
        }),
      ERROR_CODES.APPROVAL_REQUIRED
    );
    throwsCode(
      () =>
        nextInventoryState("APPROVAL_REQUIRED", "APPROVE", {
          accounting: shortage,
        }),
      ERROR_CODES.APPROVAL_REQUIRED
    );
  });

  test("APPROVE requires live shortage accounting, not approval alone", () => {
    const shortage = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    }).accounting;
    const approval = consumptionApproval();

    // F-03: approval evidence alone never proves a live shortage.
    throwsCode(
      () =>
        nextInventoryState("APPROVAL_REQUIRED", "APPROVE", {
          approvalEvidence: approval.evidence,
          approvalExpected: approval.expected,
        }),
      STATE_EVIDENCE_ERRORS.ACCOUNTING_EVIDENCE_REQUIRED
    );
    // A zero-shortage allocation cannot be approved.
    const full = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 10,
    }).accounting;
    throwsCode(
      () =>
        nextInventoryState("APPROVAL_REQUIRED", "APPROVE", {
          accounting: full,
          approvalEvidence: approval.evidence,
          approvalExpected: approval.expected,
        }),
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY
    );
    // F-04: the expected shortage must equal the live accounting shortage.
    const staleApproval = consumptionApproval({ shortageQuantity: 1 });
    throwsCode(
      () =>
        nextInventoryState("APPROVAL_REQUIRED", "APPROVE", {
          accounting: shortage,
          approvalEvidence: staleApproval.evidence,
          approvalExpected: staleApproval.expected,
        }),
      ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH
    );
  });

  test("approval and cancellation transitions", () => {
    for (const state of ["PENDING", "APPROVAL_REQUIRED", "APPROVED"]) {
      assert.equal(
        nextInventoryState(state, "CANCEL_PRE_START"),
        "RELEASED"
      );
      assert.equal(
        nextInventoryState(state, "ARCHIVE_PRE_START"),
        "RELEASED"
      );
    }
  });

  test("CONSUMED is terminal for consumption and top-up", () => {
    const consumed = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 10,
    }).accounting;
    const consumedState = consumeFull(consumed).accounting;
    assert.equal(
      nextInventoryState("CONSUMED", "RETRY_CONSUME", {
        accounting: consumedState,
      }),
      "CONSUMED"
    );
    throwsCode(
      () => nextInventoryState("CONSUMED", "START"),
      ERROR_CODES.ALREADY_CONSUMED
    );
    throwsCode(
      () => nextInventoryState("CONSUMED", "TOP_UP"),
      ERROR_CODES.TOP_UP_FORBIDDEN
    );
    assert.equal(
      nextInventoryState("CONSUMED", "CANCEL_POST_START"),
      "RELEASED_PARTIAL"
    );
    assert.equal(
      nextInventoryState("CONSUMED", "ARCHIVE_PREPARED_UNSOLS"),
      "RELEASED_PARTIAL"
    );
  });

  test("PARTIALLY_CONSUMED can only be topped up or closed", () => {
    const current = identity();
    const consumed = consumeFull(
      initialReservation({ requiredQuantity: 10, availableQuantity: 10 })
        .accounting
    ).accounting;
    throwsCode(
      () => nextInventoryState("PARTIALLY_CONSUMED", "START"),
      ERROR_CODES.ALREADY_CONSUMED
    );
    throwsCode(
      () =>
        nextInventoryState("PARTIALLY_CONSUMED", "TOP_UP", {
          topUpAuthorized: true,
          currentEpoch: 1,
          allocationKey: current.allocationKey,
          previousAllocationId: current.allocationId,
          newEpoch: 2,
        }),
      ERROR_CODES.TOP_UP_NOT_AUTHORIZED
    );
    assert.equal(
      nextInventoryState("PARTIALLY_CONSUMED", "TOP_UP", {
        managerAuthorization: managerActionAuthorization({
          allocationId: current.allocationId,
        }),
        orderId: "order-1",
        station: "KITCHEN",
        currentActorId: "actor-1",
        revision: 7,
        now: APPROVAL_NOW,
        currentEpoch: 1,
        allocationKey: current.allocationKey,
        previousAllocationId: current.allocationId,
        newEpoch: 2,
        newShortageQuantity: 0,
        accounting: {
          requiredQuantity: 10,
          heldQuantity: 0,
          consumedQuantity: 6,
          releasedHoldQuantity: 0,
          voidedQuantity: 0,
          shortageQuantity: 4,
          wasteQuantity: 0,
        },
      }),
      "PENDING"
    );
    assert.equal(
      nextInventoryState("PARTIALLY_CONSUMED", "TOP_UP", {
        managerAuthorization: managerActionAuthorization({
          allocationId: current.allocationId,
        }),
        orderId: "order-1",
        station: "KITCHEN",
        currentActorId: "actor-1",
        revision: 7,
        now: APPROVAL_NOW,
        currentEpoch: 1,
        allocationKey: current.allocationKey,
        previousAllocationId: current.allocationId,
        newEpoch: 2,
        newShortageQuantity: 2,
      }),
      "APPROVAL_REQUIRED"
    );
    throwsCode(
      () =>
        nextInventoryState("PARTIALLY_CONSUMED", "TOP_UP", {
          managerAuthorization: managerActionAuthorization({
            allocationId: current.allocationId,
          }),
          orderId: "order-1",
          station: "KITCHEN",
          currentActorId: "actor-1",
          revision: 7,
          now: APPROVAL_NOW,
          currentEpoch: 1,
          allocationKey: current.allocationKey,
          previousAllocationId: current.allocationId,
          newEpoch: 2,
          accounting: consumed,
        }),
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY
    );
    assert.equal(
      nextInventoryState("PARTIALLY_CONSUMED", "ARCHIVE_PREPARED_UNSOLS"),
      "RELEASED_PARTIAL"
    );
  });

  test("RELEASED and RELEASED_PARTIAL are terminal", () => {
    for (const state of ["RELEASED", "RELEASED_PARTIAL"]) {
      throwsCode(
        () => nextInventoryState(state, "START"),
        ERROR_CODES.TERMINAL_STATE
      );
      throwsCode(
        () => nextInventoryState(state, "RECOVERY"),
        ERROR_CODES.TERMINAL_STATE
      );
    }
  });

  test("CONSUMING is recovery-only and requires movement evidence", () => {
    throwsCode(
      () => nextInventoryState("CONSUMING", "START"),
      ERROR_CODES.INVALID_TRANSITION
    );
    const consumed = consumeFull(
      initialReservation({ requiredQuantity: 10, availableQuantity: 10 })
        .accounting
    ).accounting;
    const recoveryContext = (targetState) => ({
      managerAuthorization: managerActionAuthorization({
        action: "RECOVERY_RESOLUTION",
        targetState,
        allocationId: "al_recovery",
      }),
      orderId: "order-1",
      station: "KITCHEN",
      currentActorId: "actor-1",
      revision: 7,
      allocationId: "al_recovery",
      epoch: 1,
      now: APPROVAL_NOW,
    });
    assert.equal(
      nextInventoryState("CONSUMING", "RECOVER_CONSUMING", {
        ...recoveryContext("CONSUMED"),
        recoveryReason: "Movement reconciliation",
        targetState: "CONSUMED",
        accounting: consumed,
        movementEvidence: { movementId: "movement-1", quantity: 10 },
      }),
      "CONSUMED"
    );
    throwsCode(
      () =>
        nextInventoryState("CONSUMING", "RECOVER_CONSUMING", {
          ...recoveryContext("CONSUMED"),
          recoveryReason: "Movement reconciliation",
          targetState: "CONSUMED",
          accounting: consumed,
        }),
      STATE_EVIDENCE_ERRORS.RECOVERY_EVIDENCE_REQUIRED
    );
    assert.equal(
      nextInventoryState("CONSUMING", "RECOVER_CONSUMING", {
        ...recoveryContext("RECOVERY_REQUIRED"),
        recoveryReason: "Defer to recovery queue",
        targetState: "RECOVERY_REQUIRED",
        accounting: consumed,
        movementEvidence: { movementId: "movement-1" },
      }),
      "RECOVERY_REQUIRED"
    );
    throwsCode(
      () =>
        nextInventoryState("CONSUMING", "RECOVER_CONSUMING", {
          ...recoveryContext("RECOVERY_REQUIRED"),
          recoveryReason: "Invalid target",
          targetState: "CONSUMING",
          accounting: consumed,
          movementEvidence: { movementId: "movement-1" },
        }),
      ERROR_CODES.INVALID_RECOVERY_TARGET
    );
  });

  test("RECOVERY_REQUIRED only changes through evidenced resolution", () => {
    const consumed = consumeFull(
      initialReservation({ requiredQuantity: 10, availableQuantity: 10 })
        .accounting
    ).accounting;
    const recoveryContext = (targetState) => ({
      managerAuthorization: managerActionAuthorization({
        action: "RECOVERY_RESOLUTION",
        targetState,
        allocationId: "al_recovery",
      }),
      orderId: "order-1",
      station: "KITCHEN",
      currentActorId: "actor-1",
      revision: 7,
      allocationId: "al_recovery",
      epoch: 1,
      now: APPROVAL_NOW,
    });

    throwsCode(
      () => nextInventoryState("RECOVERY_REQUIRED", "START"),
      ERROR_CODES.RECOVERY_RESOLUTION_REQUIRED
    );
    throwsCode(
      () =>
        nextInventoryState("RECOVERY_REQUIRED", "RESOLVE_RECOVERY", {
          targetState: "CONSUMED",
          accounting: consumed,
        }),
      ERROR_CODES.RECOVERY_RESOLUTION_UNAUTHORIZED
    );
    throwsCode(
      () =>
        nextInventoryState("RECOVERY_REQUIRED", "RESOLVE_RECOVERY", {
          managerAuthorized: true,
          targetState: "CONSUMED",
          accounting: consumed,
        }),
      ERROR_CODES.RECOVERY_RESOLUTION_UNAUTHORIZED
    );
    throwsCode(
      () =>
        nextInventoryState("RECOVERY_REQUIRED", "RESOLVE_RECOVERY", {
          ...recoveryContext("CONSUMED"),
          targetState: "CONSUMED",
          accounting: consumed,
        }),
      STATE_EVIDENCE_ERRORS.RECOVERY_REASON_REQUIRED
    );
    throwsCode(
      () =>
        nextInventoryState("RECOVERY_REQUIRED", "RESOLVE_RECOVERY", {
          ...recoveryContext("CONSUMED"),
          recoveryReason: "Missing accounting",
          targetState: "CONSUMED",
        }),
      STATE_EVIDENCE_ERRORS.ACCOUNTING_EVIDENCE_REQUIRED
    );
    assert.equal(
      nextInventoryState("RECOVERY_REQUIRED", "RESOLVE_RECOVERY", {
        ...recoveryContext("CONSUMED"),
        recoveryReason: "Manual reconciliation",
        targetState: "CONSUMED",
        accounting: consumed,
      }),
      "CONSUMED"
    );
    throwsCode(
      () =>
        nextInventoryState("RECOVERY_REQUIRED", "RESOLVE_RECOVERY", {
          ...recoveryContext("RECOVERY_REQUIRED"),
          recoveryReason: "Unsupported target",
          targetState: "CONSUMING",
          accounting: consumed,
        }),
      ERROR_CODES.INVALID_RECOVERY_TARGET
    );
    const shortage = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    }).accounting;
    throwsCode(
      () =>
        nextInventoryState("RECOVERY_REQUIRED", "RESOLVE_RECOVERY", {
          ...recoveryContext("CONSUMED"),
          recoveryReason: "Contradictory target",
          targetState: "CONSUMED",
          accounting: shortage,
        }),
      ERROR_CODES.INVALID_RECOVERY_TARGET
    );
  });

  test("KDS READY requires terminal inventory and positive approved-shortage evidence", () => {
    assert.equal(
      assertKdsReadyAllowed({
        inventoryState: "CONSUMED",
        completionReason: "FULL",
        accounting: {
          requiredQuantity: 10,
          heldQuantity: 0,
          consumedQuantity: 10,
          releasedHoldQuantity: 0,
          voidedQuantity: 0,
          shortageQuantity: 0,
          wasteQuantity: 0,
        },
      }),
      true
    );
    assert.equal(
      assertKdsReadyAllowed({
        inventoryState: "PARTIALLY_CONSUMED",
        completionReason: "APPROVED_SHORTAGE",
        accounting: {
          requiredQuantity: 10,
          heldQuantity: 0,
          consumedQuantity: 6,
          releasedHoldQuantity: 0,
          voidedQuantity: 0,
          shortageQuantity: 4,
          wasteQuantity: 0,
        },
      }),
      true
    );
    throwsCode(
      () =>
        assertKdsReadyAllowed({
          inventoryState: "PARTIALLY_CONSUMED",
          completionReason: "APPROVED_SHORTAGE",
        }),
      STATE_EVIDENCE_ERRORS.ACCOUNTING_EVIDENCE_REQUIRED
    );
    throwsCode(
      () =>
        assertKdsReadyAllowed({
          inventoryState: "PARTIALLY_CONSUMED",
          completionReason: "APPROVED_SHORTAGE",
          accounting: {
            requiredQuantity: 10,
            heldQuantity: 4,
            consumedQuantity: 6,
            releasedHoldQuantity: 0,
            voidedQuantity: 0,
            shortageQuantity: 0,
            wasteQuantity: 0,
          },
        }),
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY
    );
    throwsCode(
      () =>
        assertKdsReadyAllowed({
          inventoryState: "PARTIALLY_CONSUMED",
          completionReason: "FULL",
        }),
      ERROR_CODES.PARTIAL_CONSUMPTION_UNAUTHORIZED
    );
    // F-11: residual holds block KDS READY even with positive consumption.
    throwsCode(
      () =>
        assertKdsReadyAllowed({
          inventoryState: "PARTIALLY_CONSUMED",
          completionReason: "APPROVED_SHORTAGE",
          accounting: {
            requiredQuantity: 10,
            heldQuantity: 0,
            consumedQuantity: 6,
            releasedHoldQuantity: 2,
            voidedQuantity: 0,
            shortageQuantity: 2,
            wasteQuantity: 0,
          },
        }),
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY
    );
    throwsCode(
      () =>
        assertKdsReadyAllowed({
          inventoryState: "CONSUMED",
          accounting: {
            requiredQuantity: 10,
            heldQuantity: 0,
            consumedQuantity: 8,
            releasedHoldQuantity: 2,
            voidedQuantity: 0,
            shortageQuantity: 0,
            wasteQuantity: 0,
          },
        }),
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY
    );
    for (const state of [
      "PENDING",
      "APPROVED",
      "APPROVAL_REQUIRED",
      "CONSUMING",
      "RECOVERY_REQUIRED",
    ]) {
      throwsCode(
        () => assertKdsReadyAllowed({ inventoryState: state }),
        ERROR_CODES.KDS_READY_REQUIRES_TERMINAL_INVENTORY
      );
    }
    assert.equal(
      hasActiveKdsTicket({ inventoryState: "RELEASED", kdsStatus: "READY" }),
      false
    );
    assert.equal(
      hasActiveKdsTicket({ inventoryState: "CONSUMED", kdsStatus: "READY" }),
      true
    );
  });

  test("KDS READY agrees with accounting-engine terminal output", () => {
    const reservation = initialReservation({
      requiredQuantity: 10,
      availableQuantity: 6,
    });
    const approval = consumptionApproval();
    const consumed = consumeApprovedShortage(
      reservation.accounting,
      shortageConsumptionOptions(approval)
    ).accounting;

    assert.equal(
      assertKdsReadyAllowed({
        inventoryState: "PARTIALLY_CONSUMED",
        completionReason: "APPROVED_SHORTAGE",
        accounting: consumed,
      }),
      true
    );
    // The unconsumed reservation still carries a hold and zero consumption, so
    // it cannot masquerade as a terminal PARTIALLY_CONSUMED allocation.
    throwsCode(
      () =>
        assertKdsReadyAllowed({
          inventoryState: "PARTIALLY_CONSUMED",
          completionReason: "APPROVED_SHORTAGE",
          accounting: reservation.accounting,
        }),
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY
    );
  });
});

// ---------------------------------------------------------------------------
// Approval snapshot validation
// ---------------------------------------------------------------------------

const APPROVAL_IDS = ["al_one", "al_two"];
const APPROVAL_QUANTITIES = { al_one: 2, al_two: 3 };

function approvalSnapshot(overrides = {}) {
  return {
    orderId: "order-1",
    station: "KITCHEN",
    allocationIds: APPROVAL_IDS,
    allocationQuantities: APPROVAL_QUANTITIES,
    revision: 4,
    requirementFingerprint: "req-fingerprint",
    shortageFingerprint: "shortage-fingerprint",
    policyVersion: "v2.1",
    issuedAt: APPROVAL_NOW - 1_000,
    expiresAt: APPROVAL_NOW + 30_000,
    actionActorId: "actor-1",
    firstApproval: {
      stage: 1,
      managerId: "manager-1",
      approvedAt: APPROVAL_NOW - 500,
    },
    // A self-declared high-value flag is intentionally present and ignored.
    highValue: { isHighValue: false },
    ...overrides,
  };
}

function approvalExpected(overrides = {}) {
  return {
    orderId: "order-1",
    station: "KITCHEN",
    allocationIds: APPROVAL_IDS,
    allocationQuantities: APPROVAL_QUANTITIES,
    revision: 4,
    requirementFingerprint: "req-fingerprint",
    shortageFingerprint: "shortage-fingerprint",
    policyVersion: "v2.1",
    now: APPROVAL_NOW,
    currentActorId: "actor-1",
    orderTotalAmount: 50,
    thresholdAmount: 100,
    shortageQuantity: 4,
    highValueEvaluation: defaultHighValue(),
    ...overrides,
  };
}

function approvalEvidence(overrides = {}) {
  return validateApprovalSnapshot(
    approvalSnapshot(overrides.snapshot),
    approvalExpected(overrides.expected)
  );
}

describe("approval snapshot validation", () => {
  test("a complete bound snapshot is accepted", () => {
    const result = approvalEvidence();
    assert.equal(result.valid, true);
    assert.equal(result.evidenceVersion, APPROVAL_EVIDENCE_VERSION);
    assert.equal(result.requiredApprovals, 1);
    assert.equal(result.isHighValue, false);
    assert.deepEqual(result.managerIds, ["manager-1"]);
    assert.equal(result.allocationQuantities.al_one, 2);
  });

  test("order, station, allocation, quantity, revision, and fingerprints must match", () => {
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ orderId: "order-2" }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_ORDER_MISMATCH
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ station: "BARISTA" }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_STATION_MISMATCH
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ allocationIds: ["al_one"] }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ allocationQuantities: { al_one: 2, al_two: 4 } }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_QUANTITY_MISMATCH
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ allocationQuantities: { al_one: -1, al_two: 3 } }),
          approvalExpected()
        ),
      ERROR_CODES.NEGATIVE_QUANTITY
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ revision: 5 }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_REVISION_MISMATCH
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ requirementFingerprint: "changed" }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_REQUIREMENT_MISMATCH
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ shortageFingerprint: "changed" }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ policyVersion: "v2.2" }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_POLICY_VERSION_MISMATCH
    );
  });

  test("exact approval quantities are compared exactly", () => {
    const snapshot = approvalSnapshot({
      allocationQuantities: { al_one: 2.000001, al_two: 3 },
    });
    throwsCode(
      () => validateApprovalSnapshot(snapshot, approvalExpected()),
      ERROR_CODES.APPROVAL_QUANTITY_MISMATCH
    );
    const exact = approvalEvidence({
      snapshot: {
        allocationQuantities: { al_one: 2.000001, al_two: 3 },
      },
      expected: {
        allocationQuantities: { al_one: 2.000001, al_two: 3 },
      },
    });
    assert.equal(exact.allocationQuantitiesExact.al_one, 2_000_001n);
  });

  test("expiry and challenge TTL are enforced", () => {
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({
            issuedAt: APPROVAL_NOW - 30_000,
            expiresAt: APPROVAL_NOW,
          }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_EXPIRED
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({
            issuedAt: APPROVAL_NOW - 1_000,
            expiresAt: APPROVAL_NOW - 1_000 + APPROVAL_CHALLENGE_TTL_MS + 1,
          }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_TTL_EXCEEDED
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({
            issuedAt: APPROVAL_NOW + 1_000,
            expiresAt: APPROVAL_NOW + 30_000,
          }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_NOT_YET_VALID
    );
  });

  test("self-approval is forbidden", () => {
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({
            firstApproval: { stage: 1, managerId: "actor-1" },
          }),
          approvalExpected()
        ),
      ERROR_CODES.SELF_APPROVAL_FORBIDDEN
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({
            secondApproval: { stage: 2, managerId: "actor-1" },
          }),
          approvalExpected({
            orderTotalAmount: 150,
            highValueEvaluation: defaultHighValue({
              orderTotalAmount: 150,
            }),
          })
        ),
      ERROR_CODES.SELF_APPROVAL_FORBIDDEN
    );
  });

  test("high-value status comes from trusted evaluation, not the snapshot", () => {
    // The snapshot says isHighValue:false, but the trusted evaluation says true.
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ highValue: { isHighValue: false } }),
          approvalExpected({
            orderTotalAmount: 150,
            highValueEvaluation: defaultHighValue({
              orderTotalAmount: 150,
            }),
          })
        ),
      ERROR_CODES.SECOND_MANAGER_REQUIRED
    );

    const result = validateApprovalSnapshot(
      approvalSnapshot({
        highValue: { isHighValue: false },
        secondApproval: { stage: 2, managerId: "manager-2" },
      }),
      approvalExpected({
        orderTotalAmount: 150,
        highValueEvaluation: defaultHighValue({
          orderTotalAmount: 150,
        }),
      })
    );
    assert.equal(result.isHighValue, true);
    assert.equal(result.requiredApprovals, 2);
    assert.deepEqual(result.managerIds, ["manager-1", "manager-2"]);
  });

  test("missing high-value evaluation fails closed", () => {
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot(),
          approvalExpected({ highValueEvaluation: undefined })
        ),
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot(),
          approvalExpected({ highValueEvaluation: { isHighValue: false } })
        ),
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
    );
  });

  test("approval stages are exact", () => {
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({
            firstApproval: { stage: 2, managerId: "manager-1" },
          }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_STAGE_INVALID
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({
            secondApproval: { stage: 1, managerId: "manager-2" },
          }),
          approvalExpected({
            orderTotalAmount: 150,
            highValueEvaluation: defaultHighValue({
              orderTotalAmount: 150,
            }),
          })
        ),
      ERROR_CODES.APPROVAL_STAGE_INVALID
    );
  });

  test("high-value threshold is configurable and never invented", () => {
    throwsCode(
      () =>
        evaluateHighValue({
          orderId: "order-1",
          policyVersion: "v2.1",
          actionActorId: "actor-1",
          orderTotalAmount: 100,
        }),
      ERROR_CODES.HIGH_VALUE_THRESHOLD_UNCONFIGURED
    );
    throwsCode(
      () =>
        evaluateHighValue({
          orderId: "order-1",
          policyVersion: "v2.1",
          actionActorId: "actor-1",
          orderTotalAmount: 100,
          thresholdAmount: 0,
        }),
      ERROR_CODES.HIGH_VALUE_THRESHOLD_UNCONFIGURED
    );
    // P1-02: an evaluation without an explicit actor is never trusted.
    for (const actionActorId of [undefined, null, "", " actor-1", "a|b"]) {
      throwsCode(
        () =>
          evaluateHighValue({
            orderId: "order-1",
            policyVersion: "v2.1",
            actionActorId,
            orderTotalAmount: 100,
            thresholdAmount: 100,
          }),
        ERROR_CODES.APPROVAL_REQUIRED
      );
    }
    assert.equal(
      evaluateHighValue({
        orderId: "order-1",
        policyVersion: "v2.1",
        actionActorId: "actor-1",
        orderTotalAmount: 100,
        thresholdAmount: 100,
      }).isHighValue,
      true
    );
    assert.equal(
      evaluateHighValue({
        orderId: "order-1",
        policyVersion: "v2.1",
        actionActorId: "actor-1",
        orderTotalAmount: 99,
        thresholdAmount: 100,
      }).isHighValue,
      false
    );
  });

  test("copied or boolean approval evidence is rejected by assertApprovalEvidence", () => {
    const evidence = approvalEvidence();
    const expected = approvalExpected();
    assert.equal(assertApprovalEvidence(evidence, expected), evidence);
    throwsCode(
      () => assertApprovalEvidence({ ...evidence }, expected),
      ERROR_CODES.APPROVAL_REQUIRED
    );
    throwsCode(
      () => assertApprovalEvidence({ valid: true }, expected),
      ERROR_CODES.APPROVAL_REQUIRED
    );
    throwsCode(
      () => assertApprovalEvidence(evidence, { ...expected, orderId: "order-2" }),
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
    );
    throwsCode(
      () =>
        assertApprovalEvidence(evidence, {
          ...expected,
          orderId: "order-2",
          highValueEvaluation: defaultHighValue({ orderId: "order-2" }),
        }),
      ERROR_CODES.APPROVAL_ORDER_MISMATCH
    );
  });

  test("approval actor substitution is rejected", () => {
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ actionActorId: "actor-2" }),
          approvalExpected()
        ),
      ERROR_CODES.APPROVAL_REQUIRED
    );
    const evidence = approvalEvidence();
    throwsCode(
      () =>
        assertApprovalEvidence(evidence, {
          ...approvalExpected(),
          currentActorId: "actor-2",
        }),
      ERROR_CODES.APPROVAL_REQUIRED
    );
    // The trusted high-value evaluation is also actor-bound.
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ actionActorId: "actor-2" }),
          approvalExpected({
            currentActorId: "actor-2",
            highValueEvaluation: defaultHighValue(),
          })
        ),
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
    );
  });

  test("approval shortage evidence is mandatory and exact", () => {
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot(),
          approvalExpected({ shortageQuantity: undefined })
        ),
      ERROR_CODES.INVALID_QUANTITY
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot(),
          approvalExpected({ shortageQuantity: 0 })
        ),
      ERROR_CODES.INVALID_QUANTITY
    );
    const evidence = approvalEvidence();
    throwsCode(
      () =>
        assertApprovalEvidence(evidence, {
          ...approvalExpected(),
          shortageQuantity: undefined,
        }),
      ERROR_CODES.INVALID_QUANTITY
    );
    throwsCode(
      () =>
        assertApprovalEvidence(evidence, {
          ...approvalExpected(),
          shortageQuantity: 9,
        }),
      ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH
    );
  });

  test("foreign and stale high-value evaluations are rejected", () => {
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot(),
          approvalExpected({
            highValueEvaluation: defaultHighValue({ orderId: "order-2" }),
          })
        ),
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot(),
          approvalExpected({
            highValueEvaluation: defaultHighValue({
              evaluatedAt: APPROVAL_NOW - 120_000,
            }),
          })
        ),
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot(),
          approvalExpected({
            highValueEvaluation: defaultHighValue({
              evaluatedAt: APPROVAL_NOW + 10_000,
            }),
          })
        ),
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
    );
  });

  test("changed order amount, threshold, or policy invalidates the evaluation", () => {
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot(),
          approvalExpected({ orderTotalAmount: 120 })
        ),
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot(),
          approvalExpected({ thresholdAmount: 80 })
        ),
      ERROR_CODES.HIGH_VALUE_THRESHOLD_UNCONFIGURED
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot({ policyVersion: "v2.2" }),
          approvalExpected({ policyVersion: "v2.2" })
        ),
      ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
    );
    throwsCode(
      () =>
        validateApprovalSnapshot(
          approvalSnapshot(),
          approvalExpected({ thresholdAmount: undefined })
        ),
      ERROR_CODES.INVALID_QUANTITY
    );
  });
});

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

describe("unit conversion allowlist", () => {
  test("approved conversions and explicit factors", () => {
    assert.equal(getConversionFactor("kg", "g"), 1000);
    assert.equal(getConversionFactor("g", "kg"), 0.001);
    assert.equal(getConversionFactor("L", "ml"), 1000);
    assert.equal(getConversionFactor("ml", "L"), 0.001);
    assert.equal(getConversionFactor("pcs", "pcs"), 1);

    assert.equal(convertQuantity(2, "kg", "g"), 2000);
    assert.equal(convertQuantity(500, "ml", "L"), 0.5);
    assert.equal(convertQuantity(3, "pcs", "pcs"), 3);
  });

  test("unsupported, unknown, aliased, and cross-dimension conversions are rejected", () => {
    throwsCode(
      () => getConversionFactor("kg", "ml"),
      ERROR_CODES.UNIT_DIMENSION_MISMATCH
    );
    throwsCode(
      () => getConversionFactor("L", "g"),
      ERROR_CODES.UNIT_DIMENSION_MISMATCH
    );
    throwsCode(
      () => getConversionFactor("oz", "g"),
      ERROR_CODES.UNKNOWN_UNIT
    );
    throwsCode(
      () => getConversionFactor("KG", "g"),
      ERROR_CODES.UNKNOWN_UNIT
    );
    throwsCode(
      () => getConversionFactor("kg", "kg"),
      ERROR_CODES.UNSUPPORTED_UNIT_CONVERSION
    );
    throwsCode(
      () => getConversionFactor("pcs", "kg"),
      ERROR_CODES.UNIT_DIMENSION_MISMATCH
    );
  });

  test("exact conversion preserves the canonical value", () => {
    const converted = convertQuantityForAccounting(1.2345, "g", "kg");
    assert.equal(converted.value, "0.0012345");
    assert.equal(converted.scaled, 1_234_500n);
    assert.equal(
      convertQuantityForAccounting(1.2345, "kg", "g").value,
      "1234.5"
    );
  });

  test("conversion factors are not prematurely rounded", () => {
    closeTo(convertQuantity(1.2345, "g", "kg"), 0.0012345);
    assert.equal(convertQuantityExact(1.2345, "g", "kg").value, "0.0012345");
    assert.equal(convertQuantityExact(1.2345, "kg", "g").value, "1234.5");
  });
});

// ---------------------------------------------------------------------------
// Waste accounting and signed corrections
// ---------------------------------------------------------------------------

const WASTE_NOW = APPROVAL_NOW;
const WASTE_ALLOCATION_ID = "alloc-1";
const WASTE_ALLOCATION_REVISION = 1;
let wasteCorrectionCounter = 0;

function nextCorrectionId(prefix = "corr") {
  wasteCorrectionCounter += 1;
  return `${prefix}-${wasteCorrectionCounter}`;
}

function wasteSnapshot(overrides = {}) {
  const now = overrides.now ?? WASTE_NOW;
  return {
    managerId: "manager-1",
    role: "MANAGER",
    authorizationId: "auth-1",
    action: "WASTE_CORRECTION",
    correctionId: "corr-1",
    allocationId: WASTE_ALLOCATION_ID,
    allocationRevision: WASTE_ALLOCATION_REVISION,
    correctionFingerprint: "test-fingerprint",
    approved: true,
    issuedAt: now - 1_000,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

function wasteAuthorization({ now = WASTE_NOW, expected = {}, ...overrides } = {}) {
  const claim = wasteSnapshot({ now, ...overrides });
  return issueWasteManagerAuthorization(
    claim,
    {
      correctionId: claim.correctionId,
      allocationId: claim.allocationId,
      allocationRevision: claim.allocationRevision,
      now,
      ...expected,
    },
    { verifyManager: (candidate) => candidate.managerId === "manager-1" }
  );
}

// P1-05: the authorization fingerprint is mandatory and binds the exact
// allocation, revision, correction identity, signed delta, reason, actor, and
// accounting state.
function correctionAuthorization({
  allocation,
  allocationId = WASTE_ALLOCATION_ID,
  allocationRevision = WASTE_ALLOCATION_REVISION,
  wasteDelta,
  correctionId,
  reason = "Customer changed order",
  managerId = "manager-1",
  authorizationId = "auth-1",
  now = WASTE_NOW,
  ...claimOverrides
} = {}) {
  const correctionFingerprint = computeWasteCorrectionFingerprint({
    allocationId,
    correctionId,
    wasteDelta,
    reason,
    authorizationId,
    managerId,
    allocationRevision,
    accounting: allocation,
  });
  return wasteAuthorization({
    correctionId,
    allocationId,
    allocationRevision,
    authorizationId,
    managerId,
    correctionFingerprint,
    now,
    ...claimOverrides,
  });
}

function correction(overrides = {}) {
  const allocation =
    overrides.allocation ??
    accounting({ consumedQuantity: 10, wasteQuantity: 10 });
  const wasteDelta = overrides.wasteDelta ?? -2;
  const correctionId = overrides.correctionId ?? nextCorrectionId();
  const reason = overrides.reason ?? "Customer changed order";
  const allocationId = overrides.allocationId ?? WASTE_ALLOCATION_ID;
  const allocationRevision =
    overrides.allocationRevision ?? WASTE_ALLOCATION_REVISION;
  const authorizationId = overrides.authorizationId ?? "auth-1";
  const managerId = overrides.managerId ?? "manager-1";
  const now = overrides.now ?? WASTE_NOW;

  const managerAuthorization = Object.prototype.hasOwnProperty.call(
    overrides,
    "managerAuthorization"
  )
    ? overrides.managerAuthorization
    : correctionAuthorization({
        allocation,
        allocationId,
        allocationRevision,
        wasteDelta,
        correctionId,
        reason,
        authorizationId,
        managerId,
        now,
      });

  return {
    allocation,
    allocationId,
    allocationRevision,
    wasteDelta,
    correctionId,
    reason,
    managerAuthorization,
    now,
    ...overrides,
  };
}

describe("waste accounting and signed corrections", () => {

  test("sold = C - W, waste = W, direct waste is separate", () => {
    const result = computeWasteAccounting({
      consumedQuantity: 10,
      orderLinkedWaste: 2,
      directWaste: 3,
    });
    assert.equal(result.sold, 8);
    assert.equal(result.waste, 2);
    assert.equal(result.orderLinkedWaste, 2);
    assert.equal(result.directWaste, 3);
    assert.equal(result.totalWaste, 5);
  });

  test("positive and negative corrections preserve 0 <= W <= C", () => {
    const negative = validateWasteCorrection(correction({ wasteDelta: -2 }));
    assert.equal(negative.previousWasteQuantity, 10);
    assert.equal(negative.newWasteQuantity, 8);
    assert.equal(negative.soldQuantity, 2);
    assert.equal(negative.exact.wasteDelta, -2_000_000n);

    const positive = validateWasteCorrection(
      correction({
        allocation: accounting({ consumedQuantity: 10, wasteQuantity: 8 }),
        wasteDelta: 2,
      })
    );
    assert.equal(positive.newWasteQuantity, 10);
    assert.equal(positive.soldQuantity, 0);
  });

  test("corrections beyond consumed quantity are rejected", () => {
    throwsCode(
      () => validateWasteCorrection(correction({ wasteDelta: 1 })),
      ERROR_CODES.WASTE_CORRECTION_OUT_OF_RANGE
    );
    throwsCode(
      () => validateWasteCorrection(correction({ wasteDelta: -11 })),
      ERROR_CODES.WASTE_CORRECTION_OUT_OF_RANGE
    );
  });

  test("Manager role string alone is not authorization", () => {
    throwsCode(
      () =>
        validateWasteCorrection(
          correction({
            managerAuthorization: undefined,
            managerRole: "MANAGER",
            managerId: "manager-1",
          })
        ),
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
    );
    throwsCode(
      () =>
        validateWasteCorrection(
          correction({
            managerAuthorization: wasteSnapshot({
              managerId: "manager-1",
              role: "MANAGER",
              approved: true,
            }),
          })
        ),
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
    );
    throwsCode(
      () =>
        validateWasteCorrection(
          correction({
            managerAuthorization: wasteAuthorization({
              correctionId: "other-correction",
              expected: { correctionId: "other-correction" },
            }),
          })
        ),
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
    );
  });

  test("fabricated Manager snapshots cannot be issued without trusted verification", () => {
    const fabricated = wasteSnapshot({ role: "MANAGER", approved: true });
    throwsCode(
      () => issueWasteManagerAuthorization(fabricated),
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
    );
    throwsCode(
      () =>
        issueWasteManagerAuthorization(fabricated, {}, {
          verifyManager: () => false,
        }),
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
    );
    throwsCode(
      () =>
        issueWasteManagerAuthorization(
          wasteSnapshot({ role: "WAITER" }),
          {},
          { verifyManager: () => true }
        ),
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
    );
    throwsCode(
      () =>
        issueWasteManagerAuthorization(
          wasteSnapshot({ approved: false }),
          {},
          { verifyManager: () => true }
        ),
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
    );
  });

  test("missing or expired authorization evidence fails closed", () => {
    const base = correction();
    throwsCode(
      () =>
        validateWasteCorrection({
          ...base,
          managerAuthorization: undefined,
        }),
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
    );
    const shortLived = correctionAuthorization({
      ...base,
      issuedAt: WASTE_NOW - 500,
      expiresAt: WASTE_NOW + 500,
    });
    throwsCode(
      () =>
        validateWasteCorrection({
          ...base,
          managerAuthorization: shortLived,
          now: WASTE_NOW + 2_000,
        }),
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
    );
    throwsCode(
      () =>
        correctionAuthorization({
          ...base,
          issuedAt: WASTE_NOW - WASTE_AUTHORIZATION_TTL_MS - 1,
          expiresAt: WASTE_NOW + 1_000,
        }),
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
    );
  });

  test("validated authorization evidence can be reused but not copied", () => {
    const payload = correction();
    const evidence = payload.managerAuthorization;
    assert.equal(evidence.evidenceVersion, WASTE_AUTHORIZATION_VERSION);
    assert.equal(
      validateWasteCorrection({ ...payload, managerAuthorization: evidence })
        .managerId,
      "manager-1"
    );
    throwsCode(
      () =>
        validateWasteCorrection({
          ...payload,
          managerAuthorization: { ...evidence },
        }),
      ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
    );
  });

  test("tiny signed deltas are preserved exactly or rejected explicitly", () => {
    const tiny = validateWasteCorrection(
      correction({ wasteDelta: -0.000001 })
    );
    assert.equal(tiny.newWasteQuantity, 9.999999);
    assert.equal(tiny.exact.wasteDelta, -1n);
    throwsCode(
      () => validateWasteCorrection(correction({ wasteDelta: -0.0000001 })),
      EXACT_QUANTITY_ERRORS.QUANTITY_PRECISION_UNSUPPORTED
    );
  });

  test("applying a correction never changes Q/H/C/R/S", () => {
    const before = accounting({
      requiredQuantity: 10,
      heldQuantity: 0,
      consumedQuantity: 10,
      releasedHoldQuantity: 0,
      voidedQuantity: 0,
      wasteQuantity: 10,
    });
    const applied = applyWasteCorrection(
      before,
      correction({
        allocation: before,
        wasteDelta: -4,
        correctionId: nextCorrectionId("corr-apply"),
        reason: "Kitchen quality issue",
      })
    );
    const normalizedBefore = validateAllocationAccounting(before);

    assert.equal(applied.accounting.wasteQuantity, 6);
    assert.equal(
      applied.accounting.requiredQuantity,
      normalizedBefore.requiredQuantity
    );
    assert.equal(
      applied.accounting.heldQuantity,
      normalizedBefore.heldQuantity
    );
    assert.equal(
      applied.accounting.consumedQuantity,
      normalizedBefore.consumedQuantity
    );
    assert.equal(
      applied.accounting.releasedHoldQuantity,
      normalizedBefore.releasedHoldQuantity
    );
    assert.equal(
      applied.accounting.voidedQuantity,
      normalizedBefore.voidedQuantity
    );
    assert.equal(
      applied.accounting.shortageQuantity,
      normalizedBefore.shortageQuantity
    );
    assert.equal(before.wasteQuantity, 10, "input accounting is not mutated");
  });

  test("identical duplicate corrections replay idempotently without double mutation", () => {
    const before = accounting({ consumedQuantity: 10, wasteQuantity: 10 });
    const payload = correction({
      allocation: before,
      wasteDelta: -4,
      correctionId: nextCorrectionId("corr-dup"),
      reason: "Kitchen quality issue",
    });
    const first = applyWasteCorrection(before, payload);
    assert.equal(first.idempotentReplay, false);
    assert.equal(first.accounting.wasteQuantity, 6);

    const replay = applyWasteCorrection(before, payload);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.accounting.wasteQuantity, 6);
    assert.equal(
      replay.correction.correctionFingerprint,
      first.correction.correctionFingerprint
    );
  });

  test("reusing a correction ID with a different delta is rejected", () => {
    const before = accounting({ consumedQuantity: 10, wasteQuantity: 10 });
    const correctionId = nextCorrectionId("corr-conflict");
    applyWasteCorrection(
      before,
      correction({
        allocation: before,
        wasteDelta: -4,
        correctionId,
        reason: "Kitchen quality issue",
      })
    );
    throwsCode(
      () =>
        applyWasteCorrection(
          before,
          correction({
            allocation: before,
            wasteDelta: -3,
            correctionId,
            reason: "Kitchen quality issue",
          })
        ),
      ERROR_CODES.WASTE_CORRECTION_CONFLICT
    );
  });

  test("reusing a correction ID with a different authorization is rejected", () => {
    const before = accounting({ consumedQuantity: 10, wasteQuantity: 10 });
    const correctionId = nextCorrectionId("corr-conflict");
    applyWasteCorrection(
      before,
      correction({
        allocation: before,
        wasteDelta: -4,
        correctionId,
        reason: "Kitchen quality issue",
      })
    );
    throwsCode(
      () =>
        applyWasteCorrection(
          before,
          correction({
            allocation: before,
            wasteDelta: -4,
            correctionId,
            reason: "Kitchen quality issue",
            authorizationId: "auth-2",
          })
        ),
      ERROR_CODES.WASTE_CORRECTION_CONFLICT
    );
  });
});

// ---------------------------------------------------------------------------
// Payment readiness
// ---------------------------------------------------------------------------

function station(overrides = {}) {
  const inventoryState = overrides.inventoryState ?? "CONSUMED";
  const kdsStatus = overrides.kdsStatus ?? "READY";
  const accounting = Object.prototype.hasOwnProperty.call(overrides, "accounting")
    ? overrides.accounting
    : {
        requiredQuantity: 10,
        heldQuantity: 0,
        consumedQuantity: 10,
        releasedHoldQuantity: 0,
        voidedQuantity: 0,
        shortageQuantity: 0,
        wasteQuantity: 0,
      };
  const terminal =
    inventoryState === "RELEASED" || inventoryState === "RELEASED_PARTIAL";
  return {
    station: "KITCHEN",
    kdsStatus,
    inventoryState,
    heldQuantity: 0,
    completionReason: "FULL",
    accounting,
    evidence: {
      source: "SERVER_ORDER_SNAPSHOT",
      complete: true,
      requiredQuantity: accounting?.requiredQuantity ?? 10,
      kds: {
        source: "SERVER_KDS_SNAPSHOT",
        status: kdsStatus,
        terminal,
      },
    },
    ...overrides,
  };
}

describe("payment readiness", () => {
  test("READY/SERVED order with terminal inventory is payable", () => {
    assert.equal(
      isPaymentReady({ orderStatus: "READY", stations: [station()] }),
      true
    );
    assert.equal(
      isPaymentReady({ orderStatus: "SERVED", stations: [station()] }),
      true
    );
    assert.equal(
      isPaymentReady({
        orderStatus: "PAYMENT_PENDING",
        stations: [station()],
      }),
      true
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "PAID",
        stations: [station()],
      }).code,
      ERROR_CODES.ORDER_NOT_PAYABLE
    );
  });

  test("non-payable order status is rejected", () => {
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "PENDING",
        stations: [station()],
      }).code,
      ERROR_CODES.ORDER_NOT_PAYABLE
    );
  });

  test("unresolved inventory states block payment", () => {
    for (const [state, code] of [
      ["PENDING", ERROR_CODES.STATION_PENDING],
      ["APPROVED", ERROR_CODES.STATION_APPROVED_NOT_STARTED],
      ["APPROVAL_REQUIRED", ERROR_CODES.APPROVAL_REQUIRED_PRESENT],
      ["CONSUMING", ERROR_CODES.CONSUMING_PRESENT],
      ["RECOVERY_REQUIRED", ERROR_CODES.RECOVERY_REQUIRED_PRESENT],
    ]) {
      assert.equal(
        evaluatePaymentReadiness({
          orderStatus: "READY",
          stations: [station({ inventoryState: state })],
        }).code,
        code
      );
    }
  });

  test("active holds and non-READY KDS block payment", () => {
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [
          station({
            heldQuantity: 1,
            accounting: {
              requiredQuantity: 10,
              heldQuantity: 1,
              consumedQuantity: 0,
              releasedHoldQuantity: 0,
              voidedQuantity: 0,
              shortageQuantity: 9,
              wasteQuantity: 0,
            },
          }),
        ],
      }).code,
      ERROR_CODES.ACTIVE_HOLD_REMAINS
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [station({ kdsStatus: "PREPARING" })],
      }).code,
      ERROR_CODES.STATION_NOT_READY
    );
  });

  test("inactive status cannot hide a residual hold", () => {
    // The station projection is absent; accounting remains authoritative and
    // still blocks payment (F-01).
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [
          station({
            active: false,
            heldQuantity: undefined,
            accounting: {
              requiredQuantity: 10,
              heldQuantity: 1,
              consumedQuantity: 0,
              releasedHoldQuantity: 0,
              voidedQuantity: 0,
              shortageQuantity: 9,
              wasteQuantity: 0,
            },
          }),
        ],
      }).code,
      ERROR_CODES.ACTIVE_HOLD_REMAINS
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [station({ inactive: true, heldQuantity: 0.5 })],
      }).code,
      ERROR_CODES.ACTIVE_HOLD_REMAINS
    );
  });

  test("caller cannot expand payable statuses", () => {
    throwsCode(
      () =>
        evaluatePaymentReadiness({
          orderStatus: "READY",
          stations: [station()],
          payableOrderStatuses: ["PAID"],
        }),
      ERROR_CODES.INVALID_PAYMENT_READINESS_INPUT
    );
  });

  test("missing or empty stations fail closed without explicit evidence", () => {
    throwsCode(
      () => evaluatePaymentReadiness({ orderStatus: "READY" }),
      ERROR_CODES.INVALID_PAYMENT_READINESS_INPUT
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [],
      }).code,
      PAYMENT_EVIDENCE_ERRORS.INVENTORY_STATION_EVIDENCE_REQUIRED
    );
    assert.equal(
      isPaymentReady({
        orderStatus: "READY",
        stations: [],
        noInventoryStations: true,
        stationEvidence: {
          complete: true,
          source: "SERVER_ORDER_SNAPSHOT",
          noInventoryStations: true,
        },
      }),
      true
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [],
        noInventoryStations: true,
        stationEvidence: { complete: false, source: "SERVER_ORDER_SNAPSHOT" },
      }).code,
      PAYMENT_EVIDENCE_ERRORS.INVENTORY_STATION_EVIDENCE_REQUIRED
    );
  });

  test("PARTIALLY_CONSUMED requires positive approved shortage and consumption", () => {
    const partialAccounting = (overrides = {}) => ({
      requiredQuantity: 10,
      heldQuantity: 0,
      consumedQuantity: 6,
      releasedHoldQuantity: 0,
      voidedQuantity: 0,
      shortageQuantity: 4,
      wasteQuantity: 0,
      ...overrides,
    });
    assert.equal(
      isPaymentReady({
        orderStatus: "SERVED",
        stations: [
          station({
            inventoryState: "PARTIALLY_CONSUMED",
            completionReason: "APPROVED_SHORTAGE",
            accounting: partialAccounting(),
          }),
        ],
      }),
      true
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inventoryState: "PARTIALLY_CONSUMED",
            completionReason: "APPROVED_SHORTAGE",
            accounting: partialAccounting({
              consumedQuantity: 10,
              shortageQuantity: 0,
            }),
          }),
        ],
      }).code,
      PAYMENT_EVIDENCE_ERRORS.INVALID_PARTIAL_CONSUMPTION_EVIDENCE
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inventoryState: "PARTIALLY_CONSUMED",
            completionReason: "APPROVED_SHORTAGE",
            accounting: partialAccounting({
              consumedQuantity: 0,
              shortageQuantity: 10,
            }),
          }),
        ],
      }).code,
      PAYMENT_EVIDENCE_ERRORS.INVALID_PARTIAL_CONSUMPTION_EVIDENCE
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inventoryState: "PARTIALLY_CONSUMED",
            completionReason: "FULL",
            accounting: partialAccounting(),
          }),
        ],
      }).code,
      ERROR_CODES.PARTIAL_CONSUMPTION_UNAUTHORIZED
    );
    assert.equal(
      isPaymentReady({
        orderStatus: "SERVED",
        stations: [
          station({
            inventoryState: "PARTIALLY_CONSUMED",
            completionReason: "APPROVED_SHORTAGE",
            accounting: partialAccounting(),
          }),
        ],
      }),
      true
    );
  });

  test("CONSUMED fails with contradictory accounting evidence", () => {
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [station({ shortageQuantity: 1 })],
      }).code,
      PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [station({ consumedQuantity: 0 })],
      }).code,
      PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [
          station({
            accounting: {
              requiredQuantity: 10,
              heldQuantity: 0,
              consumedQuantity: 10,
              releasedHoldQuantity: 0,
              voidedQuantity: 0,
              shortageQuantity: 2,
              wasteQuantity: 0,
            },
          }),
        ],
      }).code,
      PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE
    );
    assert.equal(
      isPaymentReady({
        orderStatus: "READY",
        stations: [
          station({
            accounting: {
              requiredQuantity: 10,
              heldQuantity: 0,
              consumedQuantity: 10,
              releasedHoldQuantity: 0,
              voidedQuantity: 0,
              shortageQuantity: 0,
              wasteQuantity: 0,
            },
          }),
        ],
      }),
      true
    );
  });

  test("released stations do not block merely for being released", () => {
    assert.equal(
      isPaymentReady({
        orderStatus: "SERVED",
        stations: [
          station({
            inventoryState: "RELEASED",
            kdsStatus: "PENDING",
            heldQuantity: 0,
            accounting: {
              requiredQuantity: 10,
              heldQuantity: 0,
              consumedQuantity: 0,
              releasedHoldQuantity: 10,
              voidedQuantity: 0,
              shortageQuantity: 0,
              wasteQuantity: 0,
            },
          }),
          station({ station: "BARISTA" }),
        ],
      }),
      true
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inventoryState: "RELEASED_PARTIAL",
            kdsStatus: "PENDING",
            heldQuantity: 3,
          }),
        ],
      }).code,
      ERROR_CODES.ACTIVE_HOLD_REMAINS
    );
  });

  test("NOT_APPLICABLE inventory with READY KDS does not block", () => {
    assert.equal(
      isPaymentReady({
        orderStatus: "READY",
        stations: [
          station({
            inventoryState: "NOT_APPLICABLE",
            accounting: {
              requiredQuantity: 0,
              heldQuantity: 0,
              consumedQuantity: 0,
              releasedHoldQuantity: 0,
              voidedQuantity: 0,
              shortageQuantity: 0,
              wasteQuantity: 0,
            },
          }),
        ],
      }),
      true
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [
          station({
            inventoryState: "NOT_APPLICABLE",
            accounting: undefined,
          }),
        ],
      }).code,
      PAYMENT_EVIDENCE_ERRORS.INCOMPLETE_ACCOUNTING_EVIDENCE
    );
  });

  test("a bare CONSUMED status is not terminal evidence", () => {
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [station({ accounting: undefined })],
      }).code,
      PAYMENT_EVIDENCE_ERRORS.INCOMPLETE_ACCOUNTING_EVIDENCE
    );
    assert.equal(
      isPaymentReady({
        orderStatus: "READY",
        stations: [station({ accounting: undefined })],
      }),
      false
    );
  });

  test("CONSUMED with a residual hold is rejected", () => {
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [
          station({
            heldQuantity: 1,
            accounting: {
              requiredQuantity: 10,
              heldQuantity: 1,
              consumedQuantity: 9,
              releasedHoldQuantity: 0,
              voidedQuantity: 0,
              shortageQuantity: 0,
              wasteQuantity: 0,
            },
          }),
        ],
      }).code,
      ERROR_CODES.ACTIVE_HOLD_REMAINS
    );
  });

  test("station projections must agree with authoritative accounting", () => {
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [station({ consumedQuantity: 7 })],
      }).code,
      PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [station({ shortageQuantity: 2 })],
      }).code,
      PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE
    );
    assert.equal(
      evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [
          station({
            inactive: true,
            accounting: {
              requiredQuantity: 10,
              heldQuantity: 0,
              consumedQuantity: 6,
              releasedHoldQuantity: 0,
              voidedQuantity: 0,
              shortageQuantity: 4,
              wasteQuantity: 0,
            },
          }),
        ],
      }).code,
      PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE
    );
  });

  test("payment readiness never calls inventory consumption", () => {
    const source = readFileSync(
      new URL("../lib/inventory-v2/domain/paymentReadiness.js", import.meta.url),
      "utf8"
    );
    for (const forbidden of [
      "consumeFull",
      "consumeApprovedShortage",
      "reclassifyWaste",
      "applyWasteCorrection",
      "releaseHold",
      "voidShortage",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `paymentReadiness.js must not reference ${forbidden}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 1.6 security regressions (P2-05)
// ---------------------------------------------------------------------------

describe("Phase 1.6 security regressions", () => {
  describe("P1-01 high-value escalation", () => {
    test("low-value evidence cannot be revalidated as high-value", () => {
      const evidence = approvalEvidence();
      assert.equal(evidence.isHighValue, false);
      throwsCode(
        () =>
          assertApprovalEvidence(
            evidence,
            approvalExpected({
              orderTotalAmount: 150,
              highValueEvaluation: defaultHighValue({
                orderTotalAmount: 150,
              }),
            })
          ),
        ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
      );
    });

    test("high-value approval requires a second distinct Manager", () => {
      const highExpected = approvalExpected({
        orderTotalAmount: 150,
        highValueEvaluation: defaultHighValue({ orderTotalAmount: 150 }),
      });
      throwsCode(
        () => validateApprovalSnapshot(approvalSnapshot(), highExpected),
        ERROR_CODES.SECOND_MANAGER_REQUIRED
      );
      throwsCode(
        () =>
          validateApprovalSnapshot(
            approvalSnapshot({
              secondApproval: { stage: 2, managerId: "manager-1" },
            }),
            highExpected
          ),
        ERROR_CODES.APPROVAL_MANAGER_DUPLICATE
      );
    });

    test("changed order total or threshold invalidates evidence", () => {
      const evidence = approvalEvidence();
      throwsCode(
        () =>
          assertApprovalEvidence(
            evidence,
            approvalExpected({
              orderTotalAmount: 60,
              highValueEvaluation: defaultHighValue({
                orderTotalAmount: 60,
              }),
            })
          ),
        ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
      );
      throwsCode(
        () =>
          assertApprovalEvidence(
            evidence,
            approvalExpected({
              thresholdAmount: 80,
              highValueEvaluation: defaultHighValue({ thresholdAmount: 80 }),
            })
          ),
        ERROR_CODES.HIGH_VALUE_THRESHOLD_UNCONFIGURED
      );
    });

    test("caller-supplied isHighValue is never trusted", () => {
      throwsCode(
        () =>
          validateApprovalSnapshot(
            approvalSnapshot({ isHighValue: true }),
            approvalExpected()
          ),
        ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
      );
      throwsCode(
        () =>
          assertApprovalEvidence(
            approvalEvidence(),
            approvalExpected({ isHighValue: false })
          ),
        ERROR_CODES.HIGH_VALUE_EVALUATION_REQUIRED
      );
    });
  });

  describe("P1-02 actor identity", () => {
    test("null, empty, whitespace, and mismatched actors are rejected", () => {
      for (const actor of [null, undefined, "", " actor-1", "actor-1 "]) {
        throwsCode(
          () =>
            validateApprovalSnapshot(
              approvalSnapshot({ actionActorId: actor }),
              approvalExpected()
            ),
          ERROR_CODES.APPROVAL_REQUIRED
        );
        throwsCode(
          () =>
            validateApprovalSnapshot(
              approvalSnapshot(),
              approvalExpected({ currentActorId: actor })
            ),
          ERROR_CODES.APPROVAL_REQUIRED
        );
        throwsCode(
          () =>
            assertApprovalEvidence(
              approvalEvidence(),
              approvalExpected({ currentActorId: actor })
            ),
          ERROR_CODES.APPROVAL_REQUIRED
        );
      }
    });
  });

  describe("P1-03 payment readiness fail-closed", () => {
    test("inactive station without accounting evidence fails closed", () => {
      assert.equal(
        evaluatePaymentReadiness({
          orderStatus: "READY",
          stations: [station({ inactive: true, accounting: undefined })],
        }).code,
        PAYMENT_EVIDENCE_ERRORS.INCOMPLETE_ACCOUNTING_EVIDENCE
      );
    });

    test("terminal stations without accounting evidence fail closed", () => {
      for (const inventoryState of ["RELEASED", "RELEASED_PARTIAL"]) {
        assert.equal(
          evaluatePaymentReadiness({
            orderStatus: "SERVED",
            stations: [station({ inventoryState, accounting: undefined })],
          }).code,
          PAYMENT_EVIDENCE_ERRORS.INCOMPLETE_ACCOUNTING_EVIDENCE
        );
      }
    });

    test("incomplete accounting shape is never treated as zero", () => {
      assert.equal(
        evaluatePaymentReadiness({
          orderStatus: "READY",
          stations: [
            station({
              accounting: {
                requiredQuantity: 10,
                heldQuantity: 0,
                consumedQuantity: 10,
                releasedHoldQuantity: 0,
                voidedQuantity: 0,
                shortageQuantity: 0,
                // wasteQuantity intentionally missing
              },
            }),
          ],
        }).code,
        PAYMENT_EVIDENCE_ERRORS.INCOMPLETE_ACCOUNTING_EVIDENCE
      );
    });

    test("missing or incomplete station completeness evidence fails closed", () => {
      assert.equal(
        evaluatePaymentReadiness({
          orderStatus: "READY",
          stations: [station({ evidence: undefined })],
        }).code,
        PAYMENT_EVIDENCE_ERRORS.INVENTORY_STATION_EVIDENCE_REQUIRED
      );
      assert.equal(
        evaluatePaymentReadiness({
          orderStatus: "READY",
          stations: [
            station({
              evidence: {
                source: "SERVER_ORDER_SNAPSHOT",
                complete: false,
                requiredQuantity: 10,
                kds: {
                  source: "SERVER_KDS_SNAPSHOT",
                  status: "READY",
                  terminal: false,
                },
              },
            }),
          ],
        }).code,
        PAYMENT_EVIDENCE_ERRORS.INVENTORY_STATION_EVIDENCE_REQUIRED
      );
    });

    // Phase 1.8 P1-03: inactive never bypasses accounting or state gates.

    test("inactive RELEASED without accounting fails closed", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inactive: true,
            inventoryState: "RELEASED",
            kdsStatus: "PENDING",
            accounting: undefined,
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(
        result.code,
        PAYMENT_EVIDENCE_ERRORS.INCOMPLETE_ACCOUNTING_EVIDENCE
      );
    });

    test("inactive RELEASED_PARTIAL without accounting fails closed", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inactive: true,
            inventoryState: "RELEASED_PARTIAL",
            kdsStatus: "PENDING",
            accounting: undefined,
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(
        result.code,
        PAYMENT_EVIDENCE_ERRORS.INCOMPLETE_ACCOUNTING_EVIDENCE
      );
    });

    test("active RELEASED without accounting fails closed", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inventoryState: "RELEASED",
            kdsStatus: "PENDING",
            accounting: undefined,
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(
        result.code,
        PAYMENT_EVIDENCE_ERRORS.INCOMPLETE_ACCOUNTING_EVIDENCE
      );
    });

    test("active RELEASED_PARTIAL without accounting fails closed", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inventoryState: "RELEASED_PARTIAL",
            kdsStatus: "PENDING",
            accounting: undefined,
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(
        result.code,
        PAYMENT_EVIDENCE_ERRORS.INCOMPLETE_ACCOUNTING_EVIDENCE
      );
    });

    test("inactive CONSUMING is never payment-ready", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inactive: true,
            inventoryState: "CONSUMING",
            accounting: accounting({ consumedQuantity: 10 }),
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(result.code, ERROR_CODES.CONSUMING_PRESENT);
    });

    test("inactive RECOVERY_REQUIRED is never payment-ready", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inactive: true,
            inventoryState: "RECOVERY_REQUIRED",
            accounting: accounting({ consumedQuantity: 10 }),
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(result.code, ERROR_CODES.RECOVERY_REQUIRED_PRESENT);
    });

    test("inactive PARTIALLY_CONSUMED with zero shortage is blocked", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inactive: true,
            inventoryState: "PARTIALLY_CONSUMED",
            completionReason: "APPROVED_SHORTAGE",
            accounting: accounting({ consumedQuantity: 10 }),
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(
        result.code,
        PAYMENT_EVIDENCE_ERRORS.INVALID_PARTIAL_CONSUMPTION_EVIDENCE
      );
    });

    test("inactive PENDING with a residual hold is blocked", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inactive: true,
            inventoryState: "PENDING",
            heldQuantity: 10,
            accounting: accounting({ heldQuantity: 10, consumedQuantity: 0 }),
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(result.code, ERROR_CODES.ACTIVE_HOLD_REMAINS);
    });

    test("inactive APPROVED with a residual hold is blocked", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inactive: true,
            inventoryState: "APPROVED",
            heldQuantity: 10,
            accounting: accounting({ heldQuantity: 10, consumedQuantity: 0 }),
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(result.code, ERROR_CODES.ACTIVE_HOLD_REMAINS);
    });

    test("inactive terminal with contradictory accounting is blocked", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station({
            inactive: true,
            inventoryState: "RELEASED",
            kdsStatus: "PENDING",
            accounting: accounting({ consumedQuantity: 10 }),
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(
        result.code,
        PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE
      );
    });

    test("a valid station cannot mask an inactive terminal station without accounting", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station(),
          station({
            inactive: true,
            inventoryState: "RELEASED",
            kdsStatus: "PENDING",
            accounting: undefined,
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(
        result.code,
        PAYMENT_EVIDENCE_ERRORS.INCOMPLETE_ACCOUNTING_EVIDENCE
      );
    });

    test("a valid station cannot mask an inactive unresolved non-terminal station", () => {
      const result = evaluatePaymentReadiness({
        orderStatus: "SERVED",
        stations: [
          station(),
          station({
            inactive: true,
            inventoryState: "CONSUMING",
            accounting: accounting({ consumedQuantity: 10 }),
          }),
        ],
      });
      assert.equal(result.ready, false);
      assert.equal(result.code, ERROR_CODES.CONSUMING_PRESENT);
    });

    test("a valid inactive RELEASED station with complete accounting stays payable", () => {
      assert.equal(
        isPaymentReady({
          orderStatus: "SERVED",
          stations: [
            station({
              inactive: true,
              inventoryState: "RELEASED",
              kdsStatus: "PENDING",
              accounting: accounting({ releasedHoldQuantity: 10 }),
            }),
          ],
        }),
        true
      );
    });

    test("a valid active terminal station stays payable", () => {
      assert.equal(
        isPaymentReady({
          orderStatus: "SERVED",
          stations: [
            station({
              inventoryState: "RELEASED_PARTIAL",
              kdsStatus: "PENDING",
              accounting: accounting({
                consumedQuantity: 6,
                releasedHoldQuantity: 4,
                wasteQuantity: 2,
              }),
            }),
          ],
        }),
        true
      );
    });
  });

  describe("P1-05 waste authorization fingerprints", () => {
    test("a missing fingerprint cannot be issued", () => {
      const base = correction();
      throwsCode(
        () =>
          issueWasteManagerAuthorization(
            wasteSnapshot({
              correctionId: base.correctionId,
              allocationId: base.allocationId,
              allocationRevision: base.allocationRevision,
              correctionFingerprint: undefined,
            }),
            {},
            { verifyManager: () => true }
          ),
        ERROR_CODES.WASTE_CORRECTION_FINGERPRINT_REQUIRED
      );
    });

    test("a fingerprint from another payload is rejected", () => {
      const base = correction();
      const substituted = correction({
        allocation: base.allocation,
        allocationId: base.allocationId,
        allocationRevision: base.allocationRevision,
        correctionId: base.correctionId,
        wasteDelta: -3,
        reason: base.reason,
      });
      throwsCode(
        () =>
          validateWasteCorrection({
            ...base,
            managerAuthorization: substituted.managerAuthorization,
          }),
        ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
      );
    });

    test("authorization is bound to the exact allocation and revision", () => {
      const base = correction();
      throwsCode(
        () => validateWasteCorrection({ ...base, allocationId: "alloc-other" }),
        ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
      );
      throwsCode(
        () => validateWasteCorrection({ ...base, allocationRevision: 2 }),
        ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
      );
    });
  });

  describe("Phase 1.8 P1-05 collision-free fingerprints", () => {
    const baseAccounting = accounting({
      consumedQuantity: 10,
      wasteQuantity: 10,
    });

    function fingerprint(overrides = {}) {
      return computeWasteCorrectionFingerprint({
        allocationId: "al_fingerprint",
        correctionId: "corr-fingerprint",
        wasteDelta: -2,
        reason: "Customer changed order",
        authorizationId: "auth-1",
        managerId: "manager-1",
        allocationRevision: 1,
        accounting: baseAccounting,
        ...overrides,
      });
    }

    test("the Phase 1.7 delimiter collision no longer collides", () => {
      const a = fingerprint({ reason: "c", authorizationId: "d|e" });
      const b = fingerprint({ reason: "c|d", authorizationId: "e" });
      assert.notEqual(a, b);
    });

    test("delimiters in every bound string field cannot collide", () => {
      assert.notEqual(
        fingerprint({ reason: "a|b" }),
        fingerprint({ reason: "a" })
      );
      assert.notEqual(
        fingerprint({ authorizationId: "x|y" }),
        fingerprint({ authorizationId: "x" })
      );
      assert.notEqual(
        fingerprint({ allocationId: "al|one" }),
        fingerprint({ allocationId: "al" })
      );
      assert.notEqual(
        fingerprint({ managerId: "m|1" }),
        fingerprint({ managerId: "m" })
      );
    });

    test("empty and missing values fail closed instead of serializing", () => {
      for (const value of [undefined, null, "", "   "]) {
        throwsCode(
          () => fingerprint({ reason: value }),
          ERROR_CODES.WASTE_CORRECTION_REASON_REQUIRED
        );
        throwsCode(
          () => fingerprint({ authorizationId: value }),
          ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
        );
        throwsCode(
          () => fingerprint({ allocationId: value }),
          ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
        );
        throwsCode(
          () => fingerprint({ managerId: value }),
          ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
        );
      }
    });

    test("Unicode is deterministic and is not silently normalized", () => {
      assert.equal(
        fingerprint({ reason: "café ☕ 漢字" }),
        fingerprint({ reason: "café ☕ 漢字" })
      );
      assert.notEqual(
        fingerprint({ reason: "cafe\u0301" }),
        fingerprint({ reason: "caf\u00e9" })
      );
    });

    test("every security-relevant field changes the fingerprint", () => {
      const base = fingerprint();
      const variants = [
        fingerprint({ wasteDelta: -3 }),
        fingerprint({ allocationRevision: 2 }),
        fingerprint({ correctionId: "corr-other" }),
        fingerprint({ reason: "Other reason" }),
        fingerprint({ authorizationId: "auth-2" }),
        fingerprint({ managerId: "manager-2" }),
        fingerprint({
          accounting: accounting({ consumedQuantity: 10, wasteQuantity: 8 }),
        }),
      ];
      for (const variant of variants) {
        assert.notEqual(variant, base);
      }
      assert.equal(new Set([base, ...variants]).size, variants.length + 1);
    });

    test("the same exact payload produces the same fingerprint", () => {
      assert.equal(fingerprint(), fingerprint());
    });

    test("fingerprints are explicitly versioned", () => {
      assert.match(fingerprint(), /^waste-correction-v3:[0-9a-f]{64}$/);
    });

    test("a legacy v2 fingerprint is rejected, not silently upgraded", () => {
      const payload = correction({
        wasteDelta: -2,
        reason: "Customer changed order",
        authorizationId: "auth-1",
        managerId: "manager-1",
      });
      const legacy = wasteAuthorization({
        correctionId: payload.correctionId,
        allocationId: payload.allocationId,
        allocationRevision: payload.allocationRevision,
        correctionFingerprint:
          "waste-correction-v2|alloc-1|corr-legacy|Customer changed order|auth-1|manager-1|1|-2000000|10000000|0|10000000|0|0|0|10000000",
      });
      throwsCode(
        () =>
          validateWasteCorrection({
            ...payload,
            managerAuthorization: legacy,
          }),
        ERROR_CODES.WASTE_CORRECTION_UNAUTHORIZED
      );
    });

    test("the former collision pair conflicts on the same correction identity", () => {
      const before = accounting({ consumedQuantity: 10, wasteQuantity: 10 });
      const correctionId = nextCorrectionId("corr-v3-conflict");
      applyWasteCorrection(
        before,
        correction({
          allocation: before,
          correctionId,
          wasteDelta: -2,
          reason: "c",
          authorizationId: "d|e",
        })
      );
      throwsCode(
        () =>
          applyWasteCorrection(
            before,
            correction({
              allocation: before,
              correctionId,
              wasteDelta: -2,
              reason: "c|d",
              authorizationId: "e",
            })
          ),
        ERROR_CODES.WASTE_CORRECTION_CONFLICT
      );
    });
  });

  describe("P1-07 quantity revision evidence", () => {
    test("movement evidence cannot be omitted or coerced", () => {
      for (const hasConsumptionMovement of [
        undefined,
        null,
        0,
        1,
        "false",
        "true",
        {},
        [],
      ]) {
        throwsCode(
          () =>
            validateQuantityRevision({
              epoch: 1,
              allocationId: "al_revision",
              hasConsumptionMovement,
            }),
          ERROR_CODES.QUANTITY_REVISION_EVIDENCE_REQUIRED
        );
      }
      throwsCode(
        () =>
          validateQuantityRevision({
            epoch: 1,
            allocationId: "al_revision",
            hasConsumptionMovement: true,
          }),
        ERROR_CODES.NEW_EPOCH_REQUIRED
      );
      assert.equal(
        validateQuantityRevision({
          epoch: 1,
          allocationId: "al_revision",
          hasConsumptionMovement: false,
        }).isNewEpoch,
        false
      );
    });
  });

  describe("P1-08 shortage consumption binding", () => {
    test("allocation identity is mandatory and exact", () => {
      const reserved = initialReservation({
        requiredQuantity: 10,
        availableQuantity: 6,
      }).accounting;
      const approval = consumptionApproval();
      for (const allocationId of [undefined, "", "al_other"]) {
        throwsCode(
          () =>
            consumeApprovedShortage(
              reserved,
              shortageConsumptionOptions(approval, { allocationId })
            ),
          ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH
        );
      }
    });

    test("required quantity is mandatory and exact", () => {
      const reserved = initialReservation({
        requiredQuantity: 10,
        availableQuantity: 6,
      }).accounting;
      const approval = consumptionApproval();
      throwsCode(
        () =>
          consumeApprovedShortage(
            reserved,
            shortageConsumptionOptions(approval, {
              requiredQuantity: undefined,
            })
          ),
        ERROR_CODES.INVALID_QUANTITY
      );
      for (const requiredQuantity of [9, 11]) {
        throwsCode(
          () =>
            consumeApprovedShortage(
              reserved,
              shortageConsumptionOptions(approval, { requiredQuantity })
            ),
          ERROR_CODES.APPROVAL_QUANTITY_MISMATCH
        );
      }
    });

    test("APPROVED START cannot consume an unbound allocation", () => {
      const reserved = initialReservation({
        requiredQuantity: 10,
        availableQuantity: 6,
      }).accounting;
      const approval = consumptionApproval();
      throwsCode(
        () =>
          nextInventoryState("APPROVED", "START", {
            accounting: reserved,
            approvalEvidence: approval.evidence,
            approvalExpected: approval.expected,
            allocationId: "al_other",
          }),
        ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH
      );
    });
  });

  describe("P2-01 terminal accounting shapes", () => {
    const releasedZero = {
      requiredQuantity: 10,
      heldQuantity: 0,
      consumedQuantity: 0,
      releasedHoldQuantity: 10,
      voidedQuantity: 0,
      shortageQuantity: 0,
      wasteQuantity: 0,
    };

    test("valid RELEASED and RELEASED_PARTIAL shapes are payable", () => {
      assert.equal(
        isPaymentReady({
          orderStatus: "SERVED",
          stations: [
            station({
              inventoryState: "RELEASED",
              kdsStatus: "PENDING",
              accounting: releasedZero,
            }),
          ],
        }),
        true
      );
      assert.equal(
        isPaymentReady({
          orderStatus: "SERVED",
          stations: [
            station({
              inventoryState: "RELEASED_PARTIAL",
              kdsStatus: "PENDING",
              accounting: {
                ...releasedZero,
                consumedQuantity: 6,
                releasedHoldQuantity: 4,
                wasteQuantity: 6,
              },
            }),
          ],
        }),
        true
      );
    });

    test("impossible terminal combinations are rejected", () => {
      assert.equal(
        evaluatePaymentReadiness({
          orderStatus: "SERVED",
          stations: [
            station({
              inventoryState: "RELEASED",
              kdsStatus: "PENDING",
              accounting: {
                ...releasedZero,
                releasedHoldQuantity: 0,
                consumedQuantity: 10,
              },
            }),
          ],
        }).code,
        PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE
      );
      assert.equal(
        evaluatePaymentReadiness({
          orderStatus: "SERVED",
          stations: [
            station({
              inventoryState: "RELEASED_PARTIAL",
              kdsStatus: "PENDING",
              accounting: {
                ...releasedZero,
                consumedQuantity: 0,
              },
            }),
          ],
        }).code,
        PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE
      );
      assert.equal(
        evaluatePaymentReadiness({
          orderStatus: "SERVED",
          stations: [
            station({
              inventoryState: "RELEASED_PARTIAL",
              kdsStatus: "PENDING",
              accounting: {
                ...releasedZero,
                consumedQuantity: 6,
                releasedHoldQuantity: 4,
                wasteQuantity: 7,
              },
            }),
          ],
        }).code,
        PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE
      );
    });

    test("terminal inventory requires terminal KDS evidence", () => {
      const released = station({
        inventoryState: "RELEASED",
        kdsStatus: "PENDING",
        accounting: releasedZero,
      });
      const nonTerminal = {
        ...released,
        evidence: {
          ...released.evidence,
          kds: { ...released.evidence.kds, terminal: false },
        },
      };
      assert.equal(
        evaluatePaymentReadiness({
          orderStatus: "SERVED",
          stations: [nonTerminal],
        }).code,
        PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE
      );
    });
  });

  describe("P2-02 quantity wire format", () => {
    test("physical quantities cannot be negative and signed deltas are separate", () => {
      throwsCode(
        () =>
          serializeExactQuantity({
            unit: "g",
            canonicalUnit: "g",
            scaled: -1n,
          }),
        ERROR_CODES.NEGATIVE_QUANTITY
      );
      throwsCode(
        () =>
          deserializeExactQuantity({
            version: EXACT_QUANTITY_WIRE_VERSION,
            unit: "g",
            canonicalUnit: "g",
            scaled: "-1",
          }),
        ERROR_CODES.INVALID_QUANTITY
      );
      const signed = serializeSignedExactQuantity({
        unit: "g",
        canonicalUnit: "g",
        scaled: -1_000_000n,
      });
      assert.equal(signed.version, EXACT_SIGNED_QUANTITY_WIRE_VERSION);
      throwsCode(
        () => deserializeExactQuantity(signed),
        ERROR_CODES.UNSUPPORTED_QUANTITY_WIRE_VERSION
      );
      throwsCode(
        () =>
          deserializeSignedExactQuantity({
            version: EXACT_QUANTITY_WIRE_VERSION,
            unit: "g",
            canonicalUnit: "g",
            scaled: "1",
          }),
        ERROR_CODES.UNSUPPORTED_QUANTITY_WIRE_VERSION
      );
    });
  });

  describe("P2-03 untrusted KDS and no-station claims", () => {
    test("caller kdsStatus cannot override authoritative KDS evidence", () => {
      const base = station();
      const preparing = {
        ...base,
        kdsStatus: "READY",
        evidence: {
          ...base.evidence,
          kds: { ...base.evidence.kds, status: "PREPARING" },
        },
      };
      const evaluation = evaluatePaymentReadiness({
        orderStatus: "READY",
        stations: [preparing],
      });
      assert.equal(evaluation.ready, false);
      assert.ok(
        evaluation.reasons.some(
          (reason) => reason.code === ERROR_CODES.STATION_NOT_READY
        )
      );

      const arbitrary = {
        ...base,
        kdsStatus: "HACK",
        evidence: {
          ...base.evidence,
          kds: { ...base.evidence.kds, status: "READY" },
        },
      };
      assert.equal(
        evaluatePaymentReadiness({
          orderStatus: "READY",
          stations: [arbitrary],
        }).ready,
        false
      );
    });

    test("missing KDS evidence fails closed", () => {
      assert.equal(
        evaluatePaymentReadiness({
          orderStatus: "READY",
          stations: [
            station({
              evidence: {
                source: "SERVER_ORDER_SNAPSHOT",
                complete: true,
                requiredQuantity: 10,
                kds: undefined,
              },
            }),
          ],
        }).code,
        PAYMENT_EVIDENCE_ERRORS.KDS_EVIDENCE_REQUIRED
      );
    });

    test("empty station lists require authoritative no-station evidence", () => {
      for (const input of [
        { orderStatus: "READY", stations: [] },
        {
          orderStatus: "READY",
          stations: [],
          noInventoryStations: true,
        },
        {
          orderStatus: "READY",
          stations: [],
          noInventoryStations: true,
          stationEvidence: {
            complete: true,
            source: "SERVER_ORDER_SNAPSHOT",
          },
        },
        {
          orderStatus: "READY",
          stations: [],
          stationEvidence: {
            complete: true,
            source: "SERVER_ORDER_SNAPSHOT",
            noInventoryStations: true,
          },
        },
      ]) {
        assert.equal(
          evaluatePaymentReadiness(input).code,
          PAYMENT_EVIDENCE_ERRORS.INVENTORY_STATION_EVIDENCE_REQUIRED
        );
      }
      assert.equal(
        isPaymentReady({
          orderStatus: "READY",
          stations: [],
          noInventoryStations: true,
          stationEvidence: {
            complete: true,
            source: "SERVER_ORDER_SNAPSHOT",
            noInventoryStations: true,
          },
        }),
        true
      );
    });
  });

  describe("P2-04 public export surface", () => {
    test("trusted-issuance and test-only helpers are not publicly exported", () => {
      for (const name of [
        "issueManagerActionAuthorization",
        "issueWasteManagerAuthorization",
        "resetWasteCorrectionLedger",
      ]) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(domainBarrel, name),
          false,
          `${name} must not be on the public domain barrel`
        );
      }
      assert.equal(typeof domainBarrel.evaluatePaymentReadiness, "function");
      assert.equal(typeof domainBarrel.consumeApprovedShortage, "function");
      assert.equal(typeof domainBarrel.assertApprovalEvidence, "function");
    });
  });
});
