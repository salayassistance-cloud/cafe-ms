// BONO Inventory V2 — canonical allocation identity (v3).
//
// Canonical tuple (exact field order):
//
//   v3|orderId|lineId|station|inventoryItemId|identityKind|identityValue|
//   lineIndex|componentIndex|ingredientIndex|occurrence|canonicalUnit
//
// `identityKind` is an explicit discriminator:
//
//   COMPONENT_ID  -> identityValue is the caller-supplied component ID
//   LINE_INDEX    -> identityValue is String(lineIndex)
//
// `lineIndex` is ALWAYS a separate field, including when a component ID is
// supplied. A component ID such as "line:1" therefore cannot collide with the
// generated line-index fallback: the tuples differ in identityKind and in the
// fallback value encoding.
//
// Serialization safety: every identity field is rejected if it contains the
// canonical delimiter "|", C0/C1/format controls, line/paragraph separators, or
// unpaired surrogates. Because every field is delimiter-free, the flat tuple is
// unambiguous.
//
// allocationKey is the SHA-256 of the epoch-free tuple; allocationId is the
// SHA-256 of key + epoch. The key is stable across epochs; the ID changes.
//
// No random values, timestamps, or runtime-dependent inputs are used.

import crypto from "node:crypto";

import {
  ERROR_CODES,
  fail,
} from "./errors.js";
import {
  assertNonNegativeInteger,
  assertPositiveInteger,
} from "./quantity.js";
import { CANONICAL_STATIONS } from "./states.js";
import { CANONICAL_ACCOUNTING_UNITS } from "./units.js";

export const ALLOCATION_TUPLE_VERSION = "v3";
export const ALLOCATION_KEY_PREFIX = "alk_";
export const ALLOCATION_ID_PREFIX = "al_";

export const ALLOCATION_IDENTITY_KINDS = Object.freeze({
  COMPONENT_ID: "COMPONENT_ID",
  LINE_INDEX: "LINE_INDEX",
});

const IDENTITY_KIND_ORDER = Object.freeze({
  COMPONENT_ID: 0,
  LINE_INDEX: 1,
});

const STATION_ORDER = Object.freeze({
  KITCHEN: 0,
  BARISTA: 1,
  HOT_DRINK: 2,
});

const UNSAFE_IDENTITY_CHARACTERS = /[|\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function assertIdentityString(value, field) {
  if (typeof value !== "string") {
    fail(ERROR_CODES.INVALID_IDENTITY, `${field} must be a string`, {
      field,
      value,
    });
  }
  if (value.length === 0 || value.trim() !== value) {
    fail(
      ERROR_CODES.INVALID_IDENTITY,
      `${field} must be non-empty without surrounding whitespace`,
      { field, value }
    );
  }
  if (typeof value.isWellFormed === "function" && !value.isWellFormed()) {
    fail(ERROR_CODES.INVALID_IDENTITY, `${field} is not well-formed Unicode`, {
      field,
      value,
    });
  }
  if (UNSAFE_IDENTITY_CHARACTERS.test(value)) {
    fail(
      ERROR_CODES.INVALID_IDENTITY,
      `${field} must not contain the canonical delimiter "|" or control characters`,
      { field, value }
    );
  }
  return value;
}

function assertStation(value) {
  const station = assertIdentityString(value, "station");
  if (!CANONICAL_STATIONS.includes(station)) {
    fail(ERROR_CODES.UNKNOWN_STATION, "Unknown canonical station", {
      station,
      allowed: CANONICAL_STATIONS,
    });
  }
  return station;
}

function assertCanonicalUnit(value) {
  // Allocation identity is an accounting identity: only g, ml, and pcs are
  // canonical here. Display units such as kg/L must be converted at the
  // boundary before an identity is minted (F-09).
  if (
    typeof value !== "string" ||
    !CANONICAL_ACCOUNTING_UNITS.includes(value)
  ) {
    fail(
      ERROR_CODES.UNKNOWN_UNIT,
      "Allocation canonicalUnit must be one of g, ml, or pcs",
      {
        field: "canonicalUnit",
        unit: value,
        allowed: CANONICAL_ACCOUNTING_UNITS,
      }
    );
  }
  return value;
}

function resolveIdentityKind(input, lineIndex) {
  if (input.componentId !== undefined && input.componentId !== null) {
    const componentId = assertIdentityString(input.componentId, "componentId");
    return Object.freeze({
      componentId,
      identityKind: ALLOCATION_IDENTITY_KINDS.COMPONENT_ID,
      identityValue: componentId,
      identityToken: `C:${componentId}`,
    });
  }
  return Object.freeze({
    componentId: null,
    identityKind: ALLOCATION_IDENTITY_KINDS.LINE_INDEX,
    identityValue: String(lineIndex),
    identityToken: `L:${lineIndex}`,
  });
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Build the deterministic v3 allocation identity for one logical epoch.
 *
 * @returns {Readonly<object>} canonical tuple, allocationKey, allocationId.
 */
export function buildAllocationIdentity(input = {}) {
  if (!input || typeof input !== "object") {
    fail(ERROR_CODES.INVALID_IDENTITY, "Identity input must be an object");
  }

  const orderId = assertIdentityString(input.orderId, "orderId");
  const lineId = assertIdentityString(input.lineId, "lineId");
  const station = assertStation(input.station);
  const inventoryItemId = assertIdentityString(
    input.inventoryItemId,
    "inventoryItemId"
  );
  const lineIndex = assertNonNegativeInteger(input.lineIndex, "lineIndex");
  const componentIndex = assertNonNegativeInteger(
    input.componentIndex,
    "componentIndex"
  );
  const ingredientIndex = assertNonNegativeInteger(
    input.ingredientIndex,
    "ingredientIndex"
  );
  const occurrence = assertNonNegativeInteger(
    input.occurrence === undefined ? 0 : input.occurrence,
    "occurrence"
  );
  const canonicalUnit = assertCanonicalUnit(input.canonicalUnit);
  const epoch = assertPositiveInteger(
    input.epoch === undefined ? 1 : input.epoch,
    "epoch"
  );
  const resolved = resolveIdentityKind(input, lineIndex);

  const canonicalTupleWithoutEpoch = [
    ALLOCATION_TUPLE_VERSION,
    orderId,
    lineId,
    station,
    inventoryItemId,
    resolved.identityKind,
    resolved.identityValue,
    String(lineIndex),
    String(componentIndex),
    String(ingredientIndex),
    String(occurrence),
    canonicalUnit,
  ].join("|");

  const canonicalTuple = `${canonicalTupleWithoutEpoch}|${epoch}`;
  const allocationKey = `${ALLOCATION_KEY_PREFIX}${sha256Hex(
    canonicalTupleWithoutEpoch
  )}`;
  const allocationId = buildAllocationIdForKey(allocationKey, epoch);

  return Object.freeze({
    version: ALLOCATION_TUPLE_VERSION,
    orderId,
    lineId,
    lineIndex,
    station,
    inventoryItemId,
    componentId: resolved.componentId,
    identityKind: resolved.identityKind,
    identityValue: resolved.identityValue,
    identityToken: resolved.identityToken,
    componentIdOrLineIndex: resolved.identityValue,
    componentIndex,
    ingredientIndex,
    occurrence,
    canonicalUnit,
    epoch,
    canonicalTupleWithoutEpoch,
    canonicalTuple,
    allocationKey,
    allocationId,
  });
}

export function buildAllocationKeyFromTuple(canonicalTupleWithoutEpoch) {
  if (
    typeof canonicalTupleWithoutEpoch !== "string" ||
    !canonicalTupleWithoutEpoch.startsWith(
      `${ALLOCATION_TUPLE_VERSION}|`
    )
  ) {
    fail(ERROR_CODES.INVALID_IDENTITY, "Invalid canonical tuple", {
      canonicalTupleWithoutEpoch,
    });
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(canonicalTupleWithoutEpoch)) {
    fail(
      ERROR_CODES.INVALID_IDENTITY,
      "Canonical tuple must not contain control characters",
      { canonicalTupleWithoutEpoch }
    );
  }
  return `${ALLOCATION_KEY_PREFIX}${sha256Hex(canonicalTupleWithoutEpoch)}`;
}

export function buildAllocationIdForKey(allocationKey, epoch) {
  if (
    typeof allocationKey !== "string" ||
    !/^alk_[0-9a-f]{64}$/.test(allocationKey)
  ) {
    fail(ERROR_CODES.INVALID_IDENTITY, "Invalid allocationKey", {
      allocationKey,
    });
  }
  const safeEpoch = assertPositiveInteger(epoch, "epoch");
  return `${ALLOCATION_ID_PREFIX}${sha256Hex(
    `${allocationKey}|epoch=${safeEpoch}`
  )}`;
}

function rebuildIdentity(identity) {
  const kind = identity.identityKind;
  if (
    kind !== ALLOCATION_IDENTITY_KINDS.COMPONENT_ID &&
    kind !== ALLOCATION_IDENTITY_KINDS.LINE_INDEX
  ) {
    fail(ERROR_CODES.INVALID_IDENTITY, "Invalid identityKind", {
      identityKind: kind,
    });
  }

  const input = {
    orderId: identity.orderId,
    lineId: identity.lineId,
    station: identity.station,
    inventoryItemId: identity.inventoryItemId,
    lineIndex: identity.lineIndex,
    componentIndex: identity.componentIndex,
    ingredientIndex: identity.ingredientIndex,
    occurrence: identity.occurrence,
    canonicalUnit: identity.canonicalUnit,
    epoch: identity.epoch,
  };

  if (kind === ALLOCATION_IDENTITY_KINDS.COMPONENT_ID) {
    input.componentId = identity.identityValue;
  }

  return buildAllocationIdentity(input);
}

/**
 * Recompute the key and ID from the canonical identity fields and verify that
 * every supplied identity field agrees. Tampered tuple/key/ID combinations fail.
 */
export function assertAllocationIdentityConsistency(identity) {
  if (!identity || typeof identity !== "object") {
    fail(ERROR_CODES.INVALID_IDENTITY, "Allocation identity is required");
  }

  const expected = rebuildIdentity(identity);
  const mismatches = [];

  for (const field of [
    "version",
    "orderId",
    "lineId",
    "lineIndex",
    "station",
    "inventoryItemId",
    "componentId",
    "identityKind",
    "identityValue",
    "identityToken",
    "componentIdOrLineIndex",
    "componentIndex",
    "ingredientIndex",
    "occurrence",
    "canonicalUnit",
    "epoch",
    "canonicalTupleWithoutEpoch",
    "canonicalTuple",
    "allocationKey",
    "allocationId",
  ]) {
    if (identity[field] !== expected[field]) {
      mismatches.push(field);
    }
  }

  if (mismatches.length > 0) {
    fail(
      ERROR_CODES.INVALID_IDENTITY,
      "Allocation identity fields do not match the canonical tuple",
      {
        mismatches,
        suppliedAllocationKey: identity.allocationKey,
        expectedAllocationKey: expected.allocationKey,
        suppliedAllocationId: identity.allocationId,
        expectedAllocationId: expected.allocationId,
      }
    );
  }

  return true;
}

/**
 * Reject duplicate allocation IDs, duplicate (allocationKey, epoch) pairs, and
 * duplicate canonical tuples within one reservation document. Every entry is
 * also checked for full identity consistency.
 */
export function assertUniqueAllocationIds(allocations) {
  const list = Array.isArray(allocations) ? allocations : [];
  const ids = new Set();
  const keyEpochs = new Set();
  const tuples = new Set();

  for (const allocation of list) {
    if (!allocation || typeof allocation !== "object") {
      fail(ERROR_CODES.INVALID_IDENTITY, "Allocation entry must be an object");
    }

    assertAllocationIdentityConsistency(allocation);

    const id = allocation.allocationId;
    const key = allocation.allocationKey;
    const epoch = allocation.epoch;
    const tuple = allocation.canonicalTuple;

    if (ids.has(id)) {
      fail(ERROR_CODES.DUPLICATE_ALLOCATION_ID, "Duplicate allocationId", {
        allocationId: id,
      });
    }
    const keyEpoch = `${key}|epoch=${epoch}`;
    if (keyEpochs.has(keyEpoch)) {
      fail(
        ERROR_CODES.DUPLICATE_ALLOCATION_ID,
        "Duplicate allocationKey/epoch pair",
        { allocationKey: key, epoch }
      );
    }
    if (tuples.has(tuple)) {
      fail(ERROR_CODES.DUPLICATE_ALLOCATION_ID, "Duplicate canonical tuple", {
        canonicalTuple: tuple,
      });
    }

    ids.add(id);
    keyEpochs.add(keyEpoch);
    tuples.add(tuple);
  }

  return true;
}

function stationRank(station) {
  const rank = STATION_ORDER[station];
  if (rank === undefined) {
    fail(ERROR_CODES.UNKNOWN_STATION, "Unknown canonical station", { station });
  }
  return rank;
}

function identityKindRank(kind) {
  const rank = IDENTITY_KIND_ORDER[kind];
  if (rank === undefined) {
    fail(ERROR_CODES.INVALID_IDENTITY, "Unknown identityKind", { kind });
  }
  return rank;
}

function compareNumbers(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareStrings(a, b) {
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Deterministic order:
 *   KITCHEN, BARISTA, HOT_DRINK,
 *   lineIndex, componentIndex, ingredientIndex,
 *   inventoryItemId, occurrence,
 *   identityKind, identityValue,
 *   allocationKey, epoch.
 * The final key/epoch pair makes the order total.
 */
export function compareAllocationOrder(a, b) {
  return (
    compareNumbers(stationRank(a.station), stationRank(b.station)) ||
    compareNumbers(a.lineIndex, b.lineIndex) ||
    compareNumbers(a.componentIndex, b.componentIndex) ||
    compareNumbers(a.ingredientIndex, b.ingredientIndex) ||
    compareStrings(a.inventoryItemId, b.inventoryItemId) ||
    compareNumbers(a.occurrence, b.occurrence) ||
    compareNumbers(identityKindRank(a.identityKind), identityKindRank(b.identityKind)) ||
    compareStrings(a.identityValue, b.identityValue) ||
    compareStrings(a.allocationKey, b.allocationKey) ||
    compareNumbers(a.epoch, b.epoch)
  );
}

export function sortAllocations(allocations) {
  if (!Array.isArray(allocations)) {
    fail(ERROR_CODES.INVALID_INPUT, "Allocations must be an array");
  }
  return [...allocations].sort(compareAllocationOrder);
}
