// BONO Inventory V2 — pure payment-readiness predicate.
//
// First release: NO payment fallback. Payment is never an inventory trigger.
// The predicate rejects any unresolved inventory, active hold, non-READY KDS
// station, or non-payable order. It performs no payment/order mutation and
// never calls a consumption or deduction function.
//
// Phase 1.6 fail-closed corrections
// --------------------------------
//   * every station must carry an authoritative server evidence contract
//     (station completeness + required quantity + KDS terminal/status);
//   * caller-supplied kdsStatus is a claim only and is compared with evidence;
//   * caller assertions that no station exists require explicit server evidence;
//   * missing/incomplete accounting evidence is never treated as zero;
//   * inactive/terminal records cannot hide a residual hold or unresolved
//     shortage; `inactive` never suppresses a state gate (Phase 1.8);
//   * terminal RELEASED / RELEASED_PARTIAL shapes are validated;
//   * requiredQuantity is compared with the authoritative requirement.
//
// Minimum server evidence contract (Phase 2 must derive these values from
// trusted server state, never from a request body):
//
//   station.evidence = {
//     source: "SERVER_ORDER_SNAPSHOT",
//     complete: true,
//     requiredQuantity: <canonical quantity>,
//     kds: {
//       source: "SERVER_KDS_SNAPSHOT",
//       status: "PENDING" | "PREPARING" | "READY",
//       terminal: <boolean>, // true when the ticket is closed/released
//     },
//   }
//
// For an empty station list:
//
//   {
//     noInventoryStations: true,
//     stationEvidence: {
//       source: "SERVER_ORDER_SNAPSHOT",
//       complete: true,
//       noInventoryStations: true,
//     },
//   }
//
// This module does not authenticate the evidence source. Phase 2 owns server
// derivation and authentication.

import {
  ERROR_CODES,
  fail,
} from "./errors.js";
import { accountingExact } from "./accounting.js";
import {
  assertScaledQuantity,
  scaledQuantitiesEqual,
} from "./quantity.js";
import {
  CANONICAL_STATIONS,
  COMPLETION_REASONS,
  INVENTORY_STATES,
  INVENTORY_STATE_VALUES,
  KDS_STATES,
  KDS_STATE_VALUES,
  TERMINAL_INVENTORY_STATES,
} from "./states.js";

// Verified V1 order lifecycle:
//   payOrder                       accepts READY/SERVED
//   submitPaymentForVerification   accepts SERVED
//   confirmPayment                 accepts PAYMENT_PENDING
// The pure predicate is shared by both gates; the order service still enforces
// the exact transition. PAID/CANCELLED/ARCHIVED are never payable here.
export const PAYABLE_ORDER_STATUSES = Object.freeze([
  "READY",
  "SERVED",
  "PAYMENT_PENDING",
]);

export const STATION_EVIDENCE_SOURCES = Object.freeze([
  "SERVER_ORDER_SNAPSHOT",
]);

export const KDS_EVIDENCE_SOURCES = Object.freeze(["SERVER_KDS_SNAPSHOT"]);

export const PAYMENT_EVIDENCE_ERRORS = Object.freeze({
  INVENTORY_STATION_EVIDENCE_REQUIRED: "INVENTORY_STATION_EVIDENCE_REQUIRED",
  CONTRADICTORY_ACCOUNTING_EVIDENCE: "CONTRADICTORY_ACCOUNTING_EVIDENCE",
  INVALID_PARTIAL_CONSUMPTION_EVIDENCE:
    "INVALID_PARTIAL_CONSUMPTION_EVIDENCE",
  INCOMPLETE_ACCOUNTING_EVIDENCE: "INCOMPLETE_ACCOUNTING_EVIDENCE",
  KDS_EVIDENCE_REQUIRED: "KDS_EVIDENCE_REQUIRED",
  REQUIRED_QUANTITY_MISMATCH: "REQUIRED_QUANTITY_MISMATCH",
  INVALID_TERMINAL_ACCOUNTING: "INVALID_TERMINAL_ACCOUNTING",
});

const REQUIRED_ACCOUNTING_FIELDS = Object.freeze([
  "requiredQuantity",
  "heldQuantity",
  "consumedQuantity",
  "releasedHoldQuantity",
  "voidedQuantity",
  "wasteQuantity",
]);

function addReason(reasons, code, message, station = null, details = {}) {
  reasons.push(
    Object.freeze({
      code,
      message,
      station,
      details: Object.freeze({ ...details }),
    })
  );
}

function contradict(reasons, stationName, message, details = {}) {
  addReason(
    reasons,
    PAYMENT_EVIDENCE_ERRORS.CONTRADICTORY_ACCOUNTING_EVIDENCE,
    message,
    stationName,
    details
  );
}

function incompleteAccounting(reasons, stationName, missing, details = {}) {
  addReason(
    reasons,
    PAYMENT_EVIDENCE_ERRORS.INCOMPLETE_ACCOUNTING_EVIDENCE,
    "Station accounting evidence is missing or incomplete",
    stationName,
    { missing, ...details }
  );
}

function accountingShape(accounting) {
  const source =
    accounting &&
    typeof accounting === "object" &&
    accounting.exact &&
    typeof accounting.exact === "object"
      ? accounting.exact
      : accounting;
  if (!source || typeof source !== "object") {
    return { complete: false, missing: REQUIRED_ACCOUNTING_FIELDS };
  }
  const missing = REQUIRED_ACCOUNTING_FIELDS.filter(
    (field) => source[field] === undefined
  );
  return { complete: missing.length === 0, missing };
}

function stationAccounting(station, reasons, stationName) {
  if (station.accounting === undefined) return null;
  const shape = accountingShape(station.accounting);
  if (!shape.complete) {
    incompleteAccounting(reasons, stationName, shape.missing);
    return null;
  }
  try {
    return accountingExact(station.accounting);
  } catch (error) {
    contradict(
      reasons,
      stationName,
      "Station accounting evidence is malformed",
      { cause: error.code }
    );
    return null;
  }
}

function stationEvidence(station, reasons, stationName) {
  const evidence = station.evidence;
  if (
    !evidence ||
    typeof evidence !== "object" ||
    evidence.complete !== true ||
    !STATION_EVIDENCE_SOURCES.includes(evidence.source)
  ) {
    addReason(
      reasons,
      PAYMENT_EVIDENCE_ERRORS.INVENTORY_STATION_EVIDENCE_REQUIRED,
      "Authoritative station evidence is required",
      stationName,
      { evidence }
    );
    return null;
  }

  let requiredQuantity = null;
  try {
    requiredQuantity = assertScaledQuantity(
      evidence.requiredQuantity,
      `evidence.requiredQuantity:${stationName}`
    );
  } catch (error) {
    addReason(
      reasons,
      PAYMENT_EVIDENCE_ERRORS.REQUIRED_QUANTITY_MISMATCH,
      "Station evidence does not carry a valid required quantity",
      stationName,
      { cause: error.code }
    );
  }

  const kds = evidence.kds;
  if (
    !kds ||
    typeof kds !== "object" ||
    !KDS_EVIDENCE_SOURCES.includes(kds.source) ||
    !KDS_STATE_VALUES.includes(kds.status) ||
    typeof kds.terminal !== "boolean"
  ) {
    addReason(
      reasons,
      PAYMENT_EVIDENCE_ERRORS.KDS_EVIDENCE_REQUIRED,
      "Authoritative KDS terminal evidence is required",
      stationName,
      { kdsEvidence: kds }
    );
    return { requiredQuantity, kds: null };
  }

  // The station's own kdsStatus is an untrusted claim. If supplied, it must
  // agree with the authoritative evidence; it is never used as the authority.
  if (station.kdsStatus !== undefined) {
    const claimed = String(station.kdsStatus || "").toUpperCase();
    if (claimed !== kds.status) {
      contradict(
        reasons,
        stationName,
        "Station kdsStatus contradicts authoritative KDS evidence",
        { claimedKdsStatus: station.kdsStatus, evidenceKdsStatus: kds.status }
      );
    }
  }
  if (station.requiredQuantity !== undefined) {
    try {
      const claimed = assertScaledQuantity(
        station.requiredQuantity,
        `requiredQuantity:${stationName}`
      );
      if (
        requiredQuantity !== null &&
        !scaledQuantitiesEqual(claimed, requiredQuantity)
      ) {
        addReason(
          reasons,
          PAYMENT_EVIDENCE_ERRORS.REQUIRED_QUANTITY_MISMATCH,
          "Station requiredQuantity contradicts authoritative evidence",
          stationName,
          {
            claimedRequiredQuantity: claimed.toString(),
            evidenceRequiredQuantity: requiredQuantity.toString(),
          }
        );
      }
    } catch (error) {
      addReason(
        reasons,
        PAYMENT_EVIDENCE_ERRORS.REQUIRED_QUANTITY_MISMATCH,
        "Station requiredQuantity is malformed",
        stationName,
        { cause: error.code }
      );
    }
  }

  return { requiredQuantity, kds };
}

function compareProjection(station, accounting, reasons, stationName) {
  for (const field of [
    "heldQuantity",
    "consumedQuantity",
    "shortageQuantity",
    "releasedHoldQuantity",
    "voidedQuantity",
    "wasteQuantity",
  ]) {
    if (station[field] === undefined) continue;
    try {
      const projected = assertScaledQuantity(
        station[field],
        `${field}:${stationName}`
      );
      if (!scaledQuantitiesEqual(projected, accounting[field])) {
        contradict(
          reasons,
          stationName,
          `Station ${field} contradicts its accounting evidence`,
          {
            field,
            projected: projected.toString(),
            accounting: accounting[field].toString(),
          }
        );
      }
    } catch (error) {
      contradict(
        reasons,
        stationName,
        `Station ${field} projection is malformed`,
        { field, cause: error.code }
      );
    }
  }
}

function partialConsumptionEvidence(station, accounting, reasons, stationName) {
  if (station.completionReason !== COMPLETION_REASONS.APPROVED_SHORTAGE) {
    addReason(
      reasons,
      ERROR_CODES.PARTIAL_CONSUMPTION_UNAUTHORIZED,
      "PARTIALLY_CONSUMED must mean approved shortage",
      stationName,
      { completionReason: station.completionReason }
    );
    return;
  }

  if (!accounting) {
    addReason(
      reasons,
      PAYMENT_EVIDENCE_ERRORS.INVALID_PARTIAL_CONSUMPTION_EVIDENCE,
      "PARTIALLY_CONSUMED requires accounting evidence",
      stationName
    );
    return;
  }

  const consumed = accounting.consumedQuantity;
  const shortage = accounting.shortageQuantity;
  if (consumed <= 0n || shortage <= 0n) {
    addReason(
      reasons,
      PAYMENT_EVIDENCE_ERRORS.INVALID_PARTIAL_CONSUMPTION_EVIDENCE,
      "PARTIALLY_CONSUMED requires positive consumption and a positive approved shortage",
      stationName,
      {
        consumedQuantity: consumed.toString(),
        shortageQuantity: shortage.toString(),
      }
    );
  }
  if (accounting.heldQuantity !== 0n || accounting.releasedHoldQuantity !== 0n) {
    addReason(
      reasons,
      PAYMENT_EVIDENCE_ERRORS.INVALID_PARTIAL_CONSUMPTION_EVIDENCE,
      "PARTIALLY_CONSUMED cannot carry a residual hold or released hold",
      stationName,
      {
        heldQuantity: accounting.heldQuantity.toString(),
        releasedHoldQuantity: accounting.releasedHoldQuantity.toString(),
      }
    );
  }
}

function consumedEvidence(station, accounting, reasons, stationName) {
  if (!accounting) {
    incompleteAccounting(reasons, stationName, ["accounting"]);
    return;
  }

  if (
    accounting.consumedQuantity <= 0n ||
    accounting.shortageQuantity !== 0n ||
    accounting.heldQuantity !== 0n ||
    accounting.releasedHoldQuantity !== 0n
  ) {
    contradict(
      reasons,
      stationName,
      "CONSUMED evidence contradicts full consumption",
      {
        heldQuantity: accounting.heldQuantity.toString(),
        consumedQuantity: accounting.consumedQuantity.toString(),
        releasedHoldQuantity: accounting.releasedHoldQuantity.toString(),
        shortageQuantity: accounting.shortageQuantity.toString(),
      }
    );
  }
}

function terminalEvidence(
  inventoryState,
  accounting,
  kds,
  reasons,
  stationName
) {
  if (!accounting) {
    incompleteAccounting(reasons, stationName, ["accounting"]);
    return;
  }

  // Common terminal invariants: no residual hold and no unresolved shortage.
  if (accounting.heldQuantity !== 0n) {
    addReason(
      reasons,
      ERROR_CODES.ACTIVE_HOLD_REMAINS,
      "Terminal station still carries an active hold",
      stationName,
      { heldQuantity: accounting.heldQuantity.toString() }
    );
  }
  if (accounting.shortageQuantity !== 0n) {
    contradict(
      reasons,
      stationName,
      "Terminal station still carries an unresolved shortage",
      { shortageQuantity: accounting.shortageQuantity.toString() }
    );
  }
  if (!kds || kds.terminal !== true) {
    contradict(
      reasons,
      stationName,
      "Terminal inventory requires terminal KDS evidence",
      { kdsEvidence: kds }
    );
  }

  if (inventoryState === INVENTORY_STATES.RELEASED) {
    if (
      accounting.consumedQuantity !== 0n ||
      accounting.wasteQuantity !== 0n
    ) {
      contradict(
        reasons,
        stationName,
        "RELEASED requires zero consumption and zero waste",
        {
          consumedQuantity: accounting.consumedQuantity.toString(),
          wasteQuantity: accounting.wasteQuantity.toString(),
        }
      );
    }
  } else if (inventoryState === INVENTORY_STATES.RELEASED_PARTIAL) {
    if (accounting.consumedQuantity <= 0n) {
      contradict(
        reasons,
        stationName,
        "RELEASED_PARTIAL requires positive consumption",
        { consumedQuantity: accounting.consumedQuantity.toString() }
      );
    }
    if (accounting.wasteQuantity > accounting.consumedQuantity) {
      contradict(
        reasons,
        stationName,
        "RELEASED_PARTIAL waste exceeds consumption",
        {
          consumedQuantity: accounting.consumedQuantity.toString(),
          wasteQuantity: accounting.wasteQuantity.toString(),
        }
      );
    }
  }
}

/**
 * @param {object} input
 * @param {string} input.orderStatus
 * @param {Array<object>} input.stations station snapshots
 * @param {boolean} [input.noInventoryStations] explicit no-station claim
 * @param {object} [input.stationEvidence] { complete: true, source }
 * @returns {{ready: boolean, code: string|null, reasons: ReadonlyArray<object>}}
 */
export function evaluatePaymentReadiness(input = {}) {
  if (!input || typeof input !== "object") {
    fail(
      ERROR_CODES.INVALID_PAYMENT_READINESS_INPUT,
      "Payment readiness input is required"
    );
  }
  if (typeof input.orderStatus !== "string" || input.orderStatus.length === 0) {
    fail(
      ERROR_CODES.INVALID_PAYMENT_READINESS_INPUT,
      "orderStatus is required"
    );
  }
  if (!Array.isArray(input.stations)) {
    fail(
      ERROR_CODES.INVALID_PAYMENT_READINESS_INPUT,
      "stations must be an array"
    );
  }
  // Caller-supplied payable/ready status is never authoritative.
  for (const field of [
    "payableOrderStatuses",
    "payable",
    "isPayable",
    "paymentReady",
    "ready",
  ]) {
    if (input[field] !== undefined) {
      fail(
        ERROR_CODES.INVALID_PAYMENT_READINESS_INPUT,
        "Caller-controlled payable status is not allowed",
        { field, value: input[field] }
      );
    }
  }

  const reasons = [];
  const orderStatus = input.orderStatus.toUpperCase();

  if (!PAYABLE_ORDER_STATUSES.includes(orderStatus)) {
    addReason(
      reasons,
      ERROR_CODES.ORDER_NOT_PAYABLE,
      "Order status is not payable",
      null,
      { orderStatus, payableOrderStatuses: PAYABLE_ORDER_STATUSES }
    );
  }

  if (input.stations.length === 0) {
    const evidence = input.stationEvidence;
    const noStations =
      input.noInventoryStations === true &&
      evidence &&
      typeof evidence === "object" &&
      evidence.complete === true &&
      evidence.noInventoryStations === true &&
      STATION_EVIDENCE_SOURCES.includes(evidence.source);
    if (!noStations) {
      addReason(
        reasons,
        PAYMENT_EVIDENCE_ERRORS.INVENTORY_STATION_EVIDENCE_REQUIRED,
        "An empty station list requires explicit no-inventory-station evidence",
        null,
        {
          noInventoryStations: input.noInventoryStations,
          stationEvidence: evidence,
        }
      );
    }
  }

  for (const station of input.stations) {
    if (!station || typeof station !== "object") {
      fail(
        ERROR_CODES.INVALID_PAYMENT_READINESS_INPUT,
        "Each station snapshot must be an object"
      );
    }

    const stationName = String(station.station || "").toUpperCase();
    if (!CANONICAL_STATIONS.includes(stationName)) {
      addReason(
        reasons,
        ERROR_CODES.UNKNOWN_STATION,
        "Unknown station in payment readiness input",
        stationName || null,
        { station: station.station }
      );
      continue;
    }

    const evidence = stationEvidence(station, reasons, stationName);

    // Residual holds block payment regardless of active/inactive status.
    const hasHeldProjection = station.heldQuantity !== undefined;
    const heldQuantity = hasHeldProjection
      ? assertScaledQuantity(
          station.heldQuantity,
          `heldQuantity:${stationName}`
        )
      : 0n;
    if (heldQuantity > 0n) {
      addReason(
        reasons,
        ERROR_CODES.ACTIVE_HOLD_REMAINS,
        "An active inventory hold remains",
        stationName,
        { heldQuantity: heldQuantity.toString() }
      );
    }

    const inventoryState = String(station.inventoryState || "").toUpperCase();
    if (!INVENTORY_STATE_VALUES.includes(inventoryState)) {
      addReason(
        reasons,
        ERROR_CODES.INVALID_INVENTORY_STATE,
        "Unknown inventory state",
        stationName,
        { inventoryState: station.inventoryState }
      );
      continue;
    }

    const accounting = stationAccounting(station, reasons, stationName);

    if (accounting) {
      const accountingHeld = accounting.heldQuantity;
      if (
        hasHeldProjection &&
        !scaledQuantitiesEqual(accountingHeld, heldQuantity)
      ) {
        contradict(
          reasons,
          stationName,
          "Station heldQuantity contradicts its accounting evidence",
          {
            heldQuantity: heldQuantity.toString(),
            accountingHeldQuantity: accountingHeld.toString(),
          }
        );
      }
      if (accountingHeld > 0n) {
        addReason(
          reasons,
          ERROR_CODES.ACTIVE_HOLD_REMAINS,
          "Accounting shows an active inventory hold",
          stationName,
          { heldQuantity: accountingHeld.toString() }
        );
      }
      compareProjection(station, accounting, reasons, stationName);

      // P2-01: compare the accounting requirement with the authoritative
      // requirement carried by server evidence.
      if (
        evidence &&
        evidence.requiredQuantity !== null &&
        !scaledQuantitiesEqual(
          accounting.requiredQuantity,
          evidence.requiredQuantity
        )
      ) {
        addReason(
          reasons,
          PAYMENT_EVIDENCE_ERRORS.REQUIRED_QUANTITY_MISMATCH,
          "Accounting requiredQuantity does not match authoritative evidence",
          stationName,
          {
            accountingRequiredQuantity: accounting.requiredQuantity.toString(),
            evidenceRequiredQuantity: evidence.requiredQuantity.toString(),
          }
        );
      }
    }

    // P1-03 / Phase 1.8: terminal and non-terminal states are validated
    // identically for active and inactive stations. `inactive` is a lifecycle
    // hint, never a reason to skip accounting or state evidence. A terminal
    // station with missing accounting fails closed inside terminalEvidence();
    // a non-terminal station is validated by its actual inventory state in the
    // switch below, so `inactive` can never suppress CONSUMING,
    // RECOVERY_REQUIRED, PARTIALLY_CONSUMED, PENDING, or APPROVED gates.
    if (TERMINAL_INVENTORY_STATES.includes(inventoryState)) {
      terminalEvidence(
        inventoryState,
        accounting,
        evidence?.kds,
        reasons,
        stationName
      );
      continue;
    }

    switch (inventoryState) {
      case INVENTORY_STATES.NOT_APPLICABLE:
        if (!accounting) {
          incompleteAccounting(reasons, stationName, ["accounting"]);
        } else if (
          accounting.requiredQuantity !== 0n ||
          accounting.heldQuantity !== 0n ||
          accounting.consumedQuantity !== 0n ||
          accounting.releasedHoldQuantity !== 0n ||
          accounting.voidedQuantity !== 0n ||
          accounting.shortageQuantity !== 0n ||
          accounting.wasteQuantity !== 0n
        ) {
          contradict(
            reasons,
            stationName,
            "NOT_APPLICABLE contradicts non-zero accounting evidence",
            {
              requiredQuantity: accounting.requiredQuantity.toString(),
              heldQuantity: accounting.heldQuantity.toString(),
              consumedQuantity: accounting.consumedQuantity.toString(),
              shortageQuantity: accounting.shortageQuantity.toString(),
            }
          );
        }
        break;
      case INVENTORY_STATES.PENDING:
        addReason(
          reasons,
          ERROR_CODES.STATION_PENDING,
          "Station inventory is still pending",
          stationName
        );
        break;
      case INVENTORY_STATES.APPROVED:
        addReason(
          reasons,
          ERROR_CODES.STATION_APPROVED_NOT_STARTED,
          "Approved station has not started preparation",
          stationName
        );
        break;
      case INVENTORY_STATES.APPROVAL_REQUIRED:
        addReason(
          reasons,
          ERROR_CODES.APPROVAL_REQUIRED_PRESENT,
          "Station requires Manager approval",
          stationName
        );
        break;
      case INVENTORY_STATES.CONSUMING:
        addReason(
          reasons,
          ERROR_CODES.CONSUMING_PRESENT,
          "Station inventory is consuming",
          stationName
        );
        break;
      case INVENTORY_STATES.RECOVERY_REQUIRED:
        addReason(
          reasons,
          ERROR_CODES.RECOVERY_REQUIRED_PRESENT,
          "Station inventory requires recovery",
          stationName
        );
        break;
      case INVENTORY_STATES.PARTIALLY_CONSUMED:
        partialConsumptionEvidence(
          station,
          accounting,
          reasons,
          stationName
        );
        break;
      case INVENTORY_STATES.CONSUMED:
        consumedEvidence(station, accounting, reasons, stationName);
        break;
      default:
        addReason(
          reasons,
          ERROR_CODES.INVALID_INVENTORY_STATE,
          "Unsupported inventory state",
          stationName,
          { inventoryState }
        );
        break;
    }

    // P2-03: KDS status is authoritative only through evidence. A caller string
    // alone can never satisfy this check.
    if (!evidence?.kds) {
      addReason(
        reasons,
        PAYMENT_EVIDENCE_ERRORS.KDS_EVIDENCE_REQUIRED,
        "Station KDS readiness requires authoritative KDS evidence",
        stationName
      );
    } else if (evidence.kds.status !== KDS_STATES.READY) {
      addReason(
        reasons,
        ERROR_CODES.STATION_NOT_READY,
        "Station KDS is not READY",
        stationName,
        {
          claimedKdsStatus: station.kdsStatus,
          evidenceKdsStatus: evidence.kds.status,
        }
      );
    }
  }

  return Object.freeze({
    ready: reasons.length === 0,
    code: reasons.length === 0 ? null : reasons[0].code,
    reasons: Object.freeze(reasons),
  });
}

export function isPaymentReady(input) {
  return evaluatePaymentReadiness(input).ready;
}

export function assertPaymentReady(input) {
  const evaluation = evaluatePaymentReadiness(input);
  if (!evaluation.ready) {
    const first = evaluation.reasons[0];
    fail(first.code, first.message, first.details);
  }
  return true;
}
