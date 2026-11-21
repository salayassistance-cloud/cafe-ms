// BONO Inventory V2 — pure allocation accounting engine (exact arithmetic).
//
// Canonical equation:
//   Q = H + C + R_hold + R_void + S
//   S = Q - H - C - R_hold - R_void
//   0 <= W <= C
//
// sold = C - W (waste.js), and W is order-linked waste only.
//
// Every transition validates the equation after applying exactly one event.
// All equation checks use scaled BigInt values (see quantity.js); no epsilon,
// no binary floating-point comparison, and no silent rounding is used.
//
// Numeric accounting fields returned to callers are display projections. The
// exact values are attached as a non-enumerable `exact` property and are the
// only values used by transitions.
//
// There is deliberately NO arbitrary partial-consumption operation: the first
// release only exposes full consumption and approved-shortage consumption.

import {
  ERROR_CODES,
  fail,
} from "./errors.js";
import { buildAllocationIdForKey } from "./allocationIdentity.js";
import { assertApprovalEvidence } from "./approval.js";
import {
  addScaledQuantities,
  assertPositiveInteger,
  assertPositiveScaledQuantity,
  assertScaledQuantity,
  scaledQuantitiesEqual,
  scaledToNumber,
} from "./quantity.js";
import {
  CANONICAL_ACCOUNTING_UNITS,
  parseQuantityInUnit,
} from "./units.js";
import {
  COMPLETION_REASONS,
  INVENTORY_STATES,
  WASTE_CLASSES,
} from "./states.js";

export const ACCOUNTING_FIELDS = Object.freeze([
  "requiredQuantity",
  "heldQuantity",
  "consumedQuantity",
  "releasedHoldQuantity",
  "voidedQuantity",
  "shortageQuantity",
  "wasteQuantity",
]);

const ALLOWED_RECLASSIFICATION_CLASSES = Object.freeze([
  WASTE_CLASSES.ORDER_LINKED,
  WASTE_CLASSES.PREPARED_UNSOLD,
]);

function assertNonEmptyIdentity(value, field, code = ERROR_CODES.INVALID_IDENTITY) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    fail(code, `${field} must be a non-empty trimmed string`, {
      field,
      value,
    });
  }
  return value;
}

function assertAccountingScaled(value, field) {
  if (value && typeof value === "object") {
    if (typeof value.scaled === "bigint") {
      if (value.canonicalUnit !== undefined) {
        if (!CANONICAL_ACCOUNTING_UNITS.includes(value.canonicalUnit)) {
          fail(
            ERROR_CODES.INVALID_INPUT,
            `${field}.canonicalUnit is not a canonical accounting unit`,
            { field, canonicalUnit: value.canonicalUnit }
          );
        }
      }
      return assertScaledQuantity(value, field);
    }
    if (value.unit !== undefined && value.value !== undefined) {
      const parsed = parseQuantityInUnit(value.value, value.unit, field);
      if (!CANONICAL_ACCOUNTING_UNITS.includes(parsed.canonicalUnit)) {
        fail(
          ERROR_CODES.INVALID_INPUT,
          `${field} does not resolve to a canonical accounting unit`,
          { field, canonicalUnit: parsed.canonicalUnit }
        );
      }
      return parsed.scaled;
    }
  }
  return assertScaledQuantity(value, field);
}

function normalizeAccountingExact(input) {
  if (!input || typeof input !== "object") {
    fail(ERROR_CODES.INVALID_QUANTITY, "Allocation accounting is required");
  }

  if (input.unit !== undefined) {
    if (!CANONICAL_ACCOUNTING_UNITS.includes(input.unit)) {
      fail(
        ERROR_CODES.INVALID_INPUT,
        "Accounting unit must be a canonical accounting unit",
        { unit: input.unit, allowed: CANONICAL_ACCOUNTING_UNITS }
      );
    }
  }

  if (input.exact && typeof input.exact === "object") {
    const exact = {};
    for (const field of ACCOUNTING_FIELDS) {
      if (
        field === "shortageQuantity" &&
        input.exact[field] === undefined
      ) {
        exact[field] = undefined;
        continue;
      }
      exact[field] = assertScaledQuantity(input.exact[field], field);
      if (input[field] !== undefined) {
        const projected = assertAccountingScaled(input[field], field);
        if (projected !== exact[field]) {
          fail(
            ERROR_CODES.EQUATION_MISMATCH,
            "Numeric accounting projection does not match the exact value",
            {
              field,
              numeric: input[field],
              exact: exact[field].toString(),
            }
          );
        }
      }
    }
    return exact;
  }

  const exact = {
    requiredQuantity: assertAccountingScaled(
      input.requiredQuantity,
      "requiredQuantity"
    ),
    heldQuantity: assertAccountingScaled(input.heldQuantity, "heldQuantity"),
    consumedQuantity: assertAccountingScaled(
      input.consumedQuantity,
      "consumedQuantity"
    ),
    releasedHoldQuantity: assertAccountingScaled(
      input.releasedHoldQuantity === undefined
        ? 0
        : input.releasedHoldQuantity,
      "releasedHoldQuantity"
    ),
    voidedQuantity: assertAccountingScaled(
      input.voidedQuantity === undefined ? 0 : input.voidedQuantity,
      "voidedQuantity"
    ),
    shortageQuantity:
      input.shortageQuantity === undefined
        ? undefined
        : assertAccountingScaled(
            input.shortageQuantity,
            "shortageQuantity"
          ),
    wasteQuantity: assertAccountingScaled(
      input.wasteQuantity === undefined ? 0 : input.wasteQuantity,
      "wasteQuantity"
    ),
  };

  return exact;
}

function validateExactAccounting(exactInput) {
  const Q = exactInput.requiredQuantity;
  const H = exactInput.heldQuantity;
  const C = exactInput.consumedQuantity;
  const RHold = exactInput.releasedHoldQuantity;
  const RVoid = exactInput.voidedQuantity;
  const W = exactInput.wasteQuantity;

  if (C > Q) {
    fail(ERROR_CODES.OVER_CONSUMPTION, "Consumed quantity exceeds required", {
      requiredQuantity: Q.toString(),
      consumedQuantity: C.toString(),
    });
  }
  if (H > Q) {
    fail(ERROR_CODES.OVER_HOLD, "Held quantity exceeds required", {
      requiredQuantity: Q.toString(),
      heldQuantity: H.toString(),
    });
  }
  if (RHold > Q) {
    fail(ERROR_CODES.OVER_RELEASE, "Released hold exceeds required", {
      requiredQuantity: Q.toString(),
      releasedHoldQuantity: RHold.toString(),
    });
  }
  if (RVoid > Q) {
    fail(ERROR_CODES.OVER_VOID, "Voided shortage exceeds required", {
      requiredQuantity: Q.toString(),
      voidedQuantity: RVoid.toString(),
    });
  }

  const derivedShortage = Q - H - C - RHold - RVoid;
  if (derivedShortage < 0n) {
    fail(
      ERROR_CODES.EQUATION_MISMATCH,
      "Allocation parts exceed required quantity",
      {
        requiredQuantity: Q.toString(),
        heldQuantity: H.toString(),
        consumedQuantity: C.toString(),
        releasedHoldQuantity: RHold.toString(),
        voidedQuantity: RVoid.toString(),
      }
    );
  }

  if (
    exactInput.shortageQuantity !== undefined &&
    exactInput.shortageQuantity !== derivedShortage
  ) {
    fail(
      ERROR_CODES.EQUATION_MISMATCH,
      "Supplied shortage does not match the accounting equation",
      {
        suppliedShortage: exactInput.shortageQuantity.toString(),
        derivedShortage: derivedShortage.toString(),
      }
    );
  }

  if (W > C) {
    fail(
      ERROR_CODES.WASTE_EXCEEDS_CONSUMPTION,
      "Waste cannot exceed consumed quantity",
      {
        consumedQuantity: C.toString(),
        wasteQuantity: W.toString(),
      }
    );
  }

  return Object.freeze({
    requiredQuantity: Q,
    heldQuantity: H,
    consumedQuantity: C,
    releasedHoldQuantity: RHold,
    voidedQuantity: RVoid,
    shortageQuantity: derivedShortage,
    wasteQuantity: W,
  });
}

function projectAccounting(exact) {
  const numeric = {};
  for (const field of ACCOUNTING_FIELDS) {
    numeric[field] = scaledToNumber(exact[field]);
  }
  Object.defineProperty(numeric, "exact", {
    value: Object.freeze({ ...exact }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(numeric);
}

/** Exact accounting map, validated. */
export function accountingExact(input) {
  return validateExactAccounting(normalizeAccountingExact(input));
}

/**
 * Validate all accounting fields and derive S. A caller-supplied shortage is
 * only accepted when it equals the derived value exactly.
 */
export function validateAllocationAccounting(input = {}) {
  return projectAccounting(accountingExact(input));
}

export function deriveShortage(input) {
  return scaledToNumber(accountingExact(input).shortageQuantity);
}

export function equationHolds(input) {
  try {
    accountingExact(input);
    return true;
  } catch {
    return false;
  }
}

function result(exact, state, completionReason = null, wasteClass = null) {
  const validated = validateExactAccounting(exact);
  return Object.freeze({
    accounting: projectAccounting(validated),
    state,
    completionReason,
    wasteClass,
  });
}

function assertNoPartialQuantityOption(options) {
  if (!options || typeof options !== "object") return;
  for (const key of [
    "quantity",
    "partialQuantity",
    "consumeQuantity",
    "requestedQuantity",
  ]) {
    if (options[key] !== undefined) {
      fail(
        ERROR_CODES.PARTIAL_CONSUMPTION_DISABLED,
        "Client-supplied consumption quantities are disabled in the first release",
        { field: key, value: options[key] }
      );
    }
  }
}

/**
 * Initial reservation / hold planning. `availableQuantity` is the net sellable
 * quantity (currentStock - reservedStock), computed by the caller inside the
 * database transaction. Existing holds count toward coverage.
 */
export function initialReservation({
  requiredQuantity,
  availableQuantity,
  alreadyHeldQuantity = 0,
}) {
  const Q = assertScaledQuantity(requiredQuantity, "requiredQuantity");
  const available = assertScaledQuantity(availableQuantity, "availableQuantity");
  const heldBefore = assertScaledQuantity(
    alreadyHeldQuantity,
    "alreadyHeldQuantity"
  );

  if (heldBefore > Q) {
    fail(ERROR_CODES.OVER_HOLD, "Existing hold exceeds required quantity", {
      requiredQuantity: Q.toString(),
      alreadyHeldQuantity: heldBefore.toString(),
    });
  }

  const coverage = heldBefore + available;
  const heldTotal = coverage < Q ? coverage : Q;
  const addedHoldQuantity = heldTotal - heldBefore;
  const shortageQuantity = Q - heldTotal;

  const accounting = projectAccounting(
    validateExactAccounting({
      requiredQuantity: Q,
      heldQuantity: heldTotal,
      consumedQuantity: 0n,
      releasedHoldQuantity: 0n,
      voidedQuantity: 0n,
      shortageQuantity,
      wasteQuantity: 0n,
    })
  );

  return Object.freeze({
    accounting,
    addedHoldQuantity: scaledToNumber(addedHoldQuantity),
    state:
      Q === 0n
        ? INVENTORY_STATES.NOT_APPLICABLE
        : shortageQuantity > 0n
          ? INVENTORY_STATES.APPROVAL_REQUIRED
          : INVENTORY_STATES.PENDING,
  });
}

/**
 * Full consumption: consumes ALL held quantity and requires no shortage.
 * This is the only ordinary PREPARING consumption path in the first release.
 *
 * A zero-required allocation can never be consumed, and no quantity override is
 * accepted.
 */
export function consumeFull(accountingInput, options = {}) {
  assertNoPartialQuantityOption(options);
  const exact = accountingExact(accountingInput);

  if (exact.requiredQuantity === 0n) {
    fail(
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
      "A zero-required allocation cannot be consumed",
      { requiredQuantity: 0 }
    );
  }
  if (exact.consumedQuantity > 0n) {
    fail(ERROR_CODES.ALREADY_CONSUMED, "Allocation is already consumed", {
      consumedQuantity: exact.consumedQuantity.toString(),
    });
  }
  if (
    exact.shortageQuantity !== 0n ||
    exact.heldQuantity !== exact.requiredQuantity
  ) {
    fail(
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
      "Full consumption requires the complete required quantity to be held",
      {
        requiredQuantity: exact.requiredQuantity.toString(),
        heldQuantity: exact.heldQuantity.toString(),
        shortageQuantity: exact.shortageQuantity.toString(),
      }
    );
  }
  if (exact.heldQuantity === 0n) {
    fail(
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
      "Full consumption requires a strictly positive held quantity"
    );
  }

  const next = {
    ...exact,
    heldQuantity: 0n,
    consumedQuantity: exact.consumedQuantity + exact.heldQuantity,
  };

  return result(next, INVENTORY_STATES.CONSUMED, COMPLETION_REASONS.FULL);
}

/**
 * P1-08: shortage consumption must be bound to one exact allocation, its
 * authoritative required quantity, the approved order/station/revision, and the
 * approval evidence. Missing or mismatched binding fields fail closed.
 */
export function assertShortageConsumptionBinding({
  exact,
  evidence,
  expected,
  allocationId,
  requiredQuantity,
} = {}) {
  if (!exact || typeof exact !== "object") {
    fail(ERROR_CODES.INVALID_INPUT, "Allocation accounting is required");
  }
  if (!expected || typeof expected !== "object") {
    fail(
      ERROR_CODES.APPROVAL_INCOMPLETE,
      "Approval expectation is required to bind shortage consumption"
    );
  }

  const safeAllocationId = assertNonEmptyIdentity(
    allocationId,
    "allocationId",
    ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH
  );
  const safeRequiredQuantity = assertScaledQuantity(
    requiredQuantity,
    "requiredQuantity"
  );
  if (
    !scaledQuantitiesEqual(safeRequiredQuantity, exact.requiredQuantity)
  ) {
    fail(
      ERROR_CODES.APPROVAL_QUANTITY_MISMATCH,
      "requiredQuantity does not match the live allocation",
      {
        requiredQuantity: safeRequiredQuantity.toString(),
        allocationRequiredQuantity: exact.requiredQuantity.toString(),
      }
    );
  }

  const expectedAllocationId = assertNonEmptyIdentity(
    expected.allocationId,
    "expected.allocationId",
    ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH
  );
  if (expectedAllocationId !== safeAllocationId) {
    fail(
      ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH,
      "Approval expectation belongs to another allocation",
      { allocationId: safeAllocationId, expectedAllocationId }
    );
  }
  const expectedRequiredQuantity = assertScaledQuantity(
    expected.requiredQuantity,
    "expected.requiredQuantity"
  );
  if (
    !scaledQuantitiesEqual(expectedRequiredQuantity, safeRequiredQuantity)
  ) {
    fail(
      ERROR_CODES.APPROVAL_QUANTITY_MISMATCH,
      "Approval expectation required quantity does not match",
      {
        requiredQuantity: safeRequiredQuantity.toString(),
        expectedRequiredQuantity: expectedRequiredQuantity.toString(),
      }
    );
  }

  if (
    !Array.isArray(evidence.allocationIds) ||
    !evidence.allocationIds.includes(safeAllocationId)
  ) {
    fail(
      ERROR_CODES.APPROVAL_ALLOCATION_MISMATCH,
      "Approval evidence does not cover the consumed allocation",
      {
        allocationId: safeAllocationId,
        allocationIds: evidence.allocationIds,
      }
    );
  }
  const approvedQuantity =
    evidence.allocationQuantitiesExact?.[safeAllocationId];
  if (
    approvedQuantity === undefined ||
    !scaledQuantitiesEqual(approvedQuantity, safeRequiredQuantity)
  ) {
    fail(
      ERROR_CODES.APPROVAL_QUANTITY_MISMATCH,
      "Approved quantity does not match the allocation requirement",
      {
        allocationId: safeAllocationId,
        approvedQuantity:
          approvedQuantity === undefined
            ? null
            : approvedQuantity.toString(),
        requiredQuantity: safeRequiredQuantity.toString(),
      }
    );
  }

  return Object.freeze({
    allocationId: safeAllocationId,
    requiredQuantity: safeRequiredQuantity,
  });
}

/**
 * Approved shortage: consumes ALL held quantity, leaves the approved shortage
 * unfulfilled, and creates no fake consumption for S.
 *
 * Requires validated approval evidence bound to the expected order, station,
 * allocations, exact quantities, revision, fingerprints, policy, and expiry.
 */
export function consumeApprovedShortage(accountingInput, options = {}) {
  assertNoPartialQuantityOption(options);
  const exact = accountingExact(accountingInput);

  if (!options || typeof options !== "object") {
    fail(
      ERROR_CODES.APPROVAL_INCOMPLETE,
      "Shortage consumption options are required"
    );
  }
  // Evidence validation runs first so a missing approval fails closed with
  // APPROVAL_REQUIRED rather than being reported as an incomplete expectation.
  const evidence = assertApprovalEvidence(
    options.approvalEvidence,
    options.approvalExpected
  );
  if (options.approvalExpected === undefined) {
    fail(
      ERROR_CODES.APPROVAL_INCOMPLETE,
      "Approval expectation is required to bind shortage consumption"
    );
  }
  assertShortageConsumptionBinding({
    exact,
    evidence,
    expected: options.approvalExpected,
    allocationId: options.allocationId,
    requiredQuantity: options.requiredQuantity,
  });

  if (exact.requiredQuantity === 0n) {
    fail(
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
      "A zero-required allocation cannot be consumed",
      { requiredQuantity: 0 }
    );
  }
  if (exact.consumedQuantity > 0n) {
    fail(ERROR_CODES.ALREADY_CONSUMED, "Allocation is already consumed", {
      consumedQuantity: exact.consumedQuantity.toString(),
    });
  }
  if (exact.shortageQuantity <= 0n) {
    fail(
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
      "Approved-shortage consumption requires a strictly positive shortage",
      { shortageQuantity: exact.shortageQuantity.toString() }
    );
  }
  if (exact.heldQuantity <= 0n) {
    fail(
      ERROR_CODES.INVALID_CONSUMPTION_QUANTITY,
      "Approved-shortage consumption requires a strictly positive held quantity",
      { heldQuantity: exact.heldQuantity.toString() }
    );
  }

  // F-04: the approved shortage is mandatory. Recompute it from the live
  // accounting state and bind it to both the evidence and the expectation.
  const expectedShortage = assertScaledQuantity(
    options.approvalExpected?.shortageQuantity,
    "expected.shortageQuantity"
  );
  if (expectedShortage <= 0n) {
    fail(
      ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH,
      "Approved shortage must be strictly positive",
      { expectedShortage: expectedShortage.toString() }
    );
  }
  if (expectedShortage !== exact.shortageQuantity) {
    fail(
      ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH,
      "Accounting shortage does not match the approved shortage",
      {
        shortageQuantity: exact.shortageQuantity.toString(),
        expectedShortage: expectedShortage.toString(),
      }
    );
  }
  if (
    !scaledQuantitiesEqual(
      evidence.shortageQuantityExact,
      exact.shortageQuantity
    )
  ) {
    fail(
      ERROR_CODES.APPROVAL_SHORTAGE_MISMATCH,
      "Approval evidence shortage does not match the live accounting shortage",
      {
        shortageQuantity: exact.shortageQuantity.toString(),
        approvedShortage: evidence.shortageQuantityExact.toString(),
      }
    );
  }

  const next = {
    ...exact,
    heldQuantity: 0n,
    consumedQuantity: exact.consumedQuantity + exact.heldQuantity,
  };

  if (next.shortageQuantity !== exact.shortageQuantity) {
    fail(
      ERROR_CODES.EQUATION_MISMATCH,
      "Approved shortage must remain unfulfilled after consumption",
      {
        before: exact.shortageQuantity.toString(),
        after: next.shortageQuantity.toString(),
      }
    );
  }

  if (evidence.allocationIds.length === 0) {
    fail(ERROR_CODES.APPROVAL_REQUIRED, "Approval evidence covers no allocations");
  }

  return result(
    next,
    INVENTORY_STATES.PARTIALLY_CONSUMED,
    COMPLETION_REASONS.APPROVED_SHORTAGE
  );
}

/** Release a precise amount of an active hold. Over-release is rejected. */
export function releaseHold(accountingInput, quantity) {
  const exact = accountingExact(accountingInput);
  const qty = assertPositiveScaledQuantity(quantity, "releaseQuantity");

  if (qty > exact.heldQuantity) {
    fail(ERROR_CODES.OVER_RELEASE, "Cannot release more than is held", {
      heldQuantity: exact.heldQuantity.toString(),
      releaseQuantity: qty.toString(),
    });
  }

  const next = {
    ...exact,
    heldQuantity: exact.heldQuantity - qty,
    releasedHoldQuantity: exact.releasedHoldQuantity + qty,
  };
  return Object.freeze({
    accounting: projectAccounting(validateExactAccounting(next)),
  });
}

/** Void a precise amount of shortage. Over-voiding is rejected. */
export function voidShortage(accountingInput, quantity) {
  const exact = accountingExact(accountingInput);
  const qty = assertPositiveScaledQuantity(quantity, "voidQuantity");

  if (qty > exact.shortageQuantity) {
    fail(ERROR_CODES.OVER_VOID, "Cannot void more than the shortage", {
      shortageQuantity: exact.shortageQuantity.toString(),
      voidQuantity: qty.toString(),
    });
  }

  const next = {
    ...exact,
    voidedQuantity: exact.voidedQuantity + qty,
    shortageQuantity: exact.shortageQuantity - qty,
  };
  return Object.freeze({
    accounting: projectAccounting(validateExactAccounting(next)),
  });
}

function releaseAll(exact) {
  return {
    ...exact,
    heldQuantity: 0n,
    releasedHoldQuantity: exact.releasedHoldQuantity + exact.heldQuantity,
    voidedQuantity: exact.voidedQuantity + exact.shortageQuantity,
    shortageQuantity: 0n,
  };
}

/** Cancellation before any physical consumption. */
export function cancelPreStart(accountingInput) {
  const exact = accountingExact(accountingInput);
  if (exact.consumedQuantity > 0n) {
    fail(
      ERROR_CODES.CONSUMPTION_ALREADY_STARTED,
      "Pre-start cancellation is not allowed after consumption",
      { consumedQuantity: exact.consumedQuantity.toString() }
    );
  }
  return result(releaseAll(exact), INVENTORY_STATES.RELEASED);
}

/**
 * Cancellation after consumption. Consumed stock is never restored; it is
 * reclassified as order-linked waste. Remaining hold/shortage is released.
 */
export function cancelPostStart(accountingInput) {
  const exact = accountingExact(accountingInput);
  if (exact.consumedQuantity <= 0n) {
    fail(
      ERROR_CODES.POST_START_REQUIRES_CONSUMPTION,
      "Post-start cancellation requires physical consumption",
      { consumedQuantity: exact.consumedQuantity.toString() }
    );
  }

  const next = {
    ...releaseAll(exact),
    // All consumption for this allocation becomes order-linked waste.
    wasteQuantity: exact.consumedQuantity,
  };

  return result(
    next,
    INVENTORY_STATES.RELEASED_PARTIAL,
    COMPLETION_REASONS.POST_START_CANCELLED,
    WASTE_CLASSES.ORDER_LINKED
  );
}

export function archiveBeforePreparation(accountingInput) {
  return result(
    cancelPreStart(accountingInput).accounting.exact,
    INVENTORY_STATES.RELEASED
  );
}

/**
 * Prepared-but-unsold archive: consumption already happened, the order is not
 * paid, and the consumed quantity is reclassified as PREPARED_UNSOLD waste.
 */
export function archivePreparedUnsold(accountingInput) {
  const exact = accountingExact(accountingInput);
  if (exact.consumedQuantity <= 0n) {
    fail(
      ERROR_CODES.POST_START_REQUIRES_CONSUMPTION,
      "Prepared-but-unsold archive requires physical consumption",
      { consumedQuantity: exact.consumedQuantity.toString() }
    );
  }

  const next = {
    ...releaseAll(exact),
    wasteQuantity: exact.consumedQuantity,
  };

  return result(
    next,
    INVENTORY_STATES.RELEASED_PARTIAL,
    COMPLETION_REASONS.PREPARED_UNSOLD,
    WASTE_CLASSES.PREPARED_UNSOLD
  );
}

/**
 * Reclassify already-consumed quantity as waste (line void / prepared unsold).
 * Never changes Q, H, C, R_hold, R_void, or S.
 */
export function reclassifyWaste(
  accountingInput,
  { quantity, wasteClass = WASTE_CLASSES.ORDER_LINKED } = {}
) {
  const exact = accountingExact(accountingInput);
  const qty = assertPositiveScaledQuantity(quantity, "wasteQuantityDelta");

  if (!ALLOWED_RECLASSIFICATION_CLASSES.includes(wasteClass)) {
    fail(ERROR_CODES.INVALID_WASTE_CLASS, "Unsupported waste reclassification", {
      wasteClass,
      allowed: ALLOWED_RECLASSIFICATION_CLASSES,
    });
  }

  const newWaste = exact.wasteQuantity + qty;
  if (newWaste > exact.consumedQuantity) {
    fail(
      ERROR_CODES.WASTE_EXCEEDS_CONSUMPTION,
      "Reclassified waste cannot exceed consumed quantity",
      {
        consumedQuantity: exact.consumedQuantity.toString(),
        newWasteQuantity: newWaste.toString(),
      }
    );
  }

  const next = { ...exact, wasteQuantity: newWaste };
  return Object.freeze({
    accounting: projectAccounting(validateExactAccounting(next)),
    wasteClass,
  });
}

/**
 * Before a consumption movement exists, a quantity revision keeps the epoch
 * and the allocation ID. After consumption, a new epoch is mandatory.
 */
export function validateQuantityRevision({
  epoch,
  allocationId = null,
  hasConsumptionMovement,
} = {}) {
  const safeEpoch = assertPositiveInteger(epoch, "epoch");

  // P1-07: movement evidence is mandatory. Missing/undefined/non-boolean
  // evidence can never be interpreted as "no consumption movement".
  if (typeof hasConsumptionMovement !== "boolean") {
    fail(
      ERROR_CODES.QUANTITY_REVISION_EVIDENCE_REQUIRED,
      "hasConsumptionMovement must be explicitly supplied as a boolean",
      { epoch: safeEpoch, allocationId, hasConsumptionMovement }
    );
  }

  let safeAllocationId = null;
  if (allocationId !== null && allocationId !== undefined) {
    safeAllocationId = assertNonEmptyIdentity(
      allocationId,
      "allocationId"
    );
  }

  if (hasConsumptionMovement) {
    fail(
      ERROR_CODES.NEW_EPOCH_REQUIRED,
      "A new allocation epoch is required after consumption",
      { epoch: safeEpoch, allocationId: safeAllocationId }
    );
  }
  return Object.freeze({
    epoch: safeEpoch,
    allocationId: safeAllocationId,
    hasConsumptionMovement: false,
    isNewEpoch: false,
  });
}

/**
 * Top-up validation: only PARTIALLY_CONSUMED allocations may be topped up, a
 * new immutable epoch is mandatory, and the predecessor is linked explicitly.
 */
export function validateTopUpEpoch({
  state,
  currentEpoch,
  allocationKey,
  previousAllocationId,
  nextEpoch,
  newShortageQuantity = 0,
} = {}) {
  const normalizedState = String(state || "").toUpperCase();

  if (normalizedState === INVENTORY_STATES.CONSUMED) {
    fail(
      ERROR_CODES.TOP_UP_FORBIDDEN,
      "A fully consumed allocation cannot be topped up; create a new order",
      { state: normalizedState }
    );
  }
  if (normalizedState !== INVENTORY_STATES.PARTIALLY_CONSUMED) {
    fail(
      ERROR_CODES.TOP_UP_NOT_ALLOWED,
      "Top-up is only allowed from PARTIALLY_CONSUMED",
      { state: normalizedState }
    );
  }

  const epoch = assertPositiveInteger(currentEpoch, "currentEpoch");
  const expectedEpoch = epoch + 1;
  if (nextEpoch !== undefined && nextEpoch !== expectedEpoch) {
    fail(ERROR_CODES.TOP_UP_EPOCH_INVALID, "Top-up epoch must increment by one", {
      currentEpoch: epoch,
      nextEpoch,
      expectedEpoch,
    });
  }

  if (typeof allocationKey !== "string" || allocationKey.length === 0) {
    fail(ERROR_CODES.INVALID_IDENTITY, "allocationKey is required for top-up");
  }
  const expectedPreviousId = buildAllocationIdForKey(allocationKey, epoch);
  if (
    typeof previousAllocationId !== "string" ||
    previousAllocationId.length === 0 ||
    previousAllocationId !== expectedPreviousId
  ) {
    fail(
      ERROR_CODES.TOP_UP_PREDECESSOR_REQUIRED,
      "Top-up must link the exact predecessor allocation ID",
      { previousAllocationId, expectedPreviousId }
    );
  }

  const shortage = assertScaledQuantity(
    newShortageQuantity,
    "newShortageQuantity"
  );

  return Object.freeze({
    previousEpoch: epoch,
    epoch: expectedEpoch,
    allocationKey,
    allocationId: buildAllocationIdForKey(allocationKey, expectedEpoch),
    reopenedFromAllocationId: previousAllocationId,
    requiresFreshApproval: shortage > 0n,
    newShortageQuantity: scaledToNumber(shortage),
  });
}

/**
 * Signed waste deltas are validated by waste.js. Accounting must never accept
 * them directly because they do not change Q/H/C/R_hold/R_void/S.
 */
export function assertNoAccountingChange(beforeInput, afterInput) {
  const before = accountingExact(beforeInput);
  const after = accountingExact(afterInput);
  const changed = [
    "requiredQuantity",
    "heldQuantity",
    "consumedQuantity",
    "releasedHoldQuantity",
    "voidedQuantity",
    "shortageQuantity",
  ].filter((field) => !scaledQuantitiesEqual(before[field], after[field]));
  if (changed.length > 0) {
    fail(
      ERROR_CODES.EQUATION_MISMATCH,
      "Waste correction must not change allocation accounting",
      { changed }
    );
  }
  return true;
}
