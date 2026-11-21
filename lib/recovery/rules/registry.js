// WP04-01 — D01–D10 read-only detection rule registry.
//
// This module is the single source of truth for the first-release WP-04
// detection vocabulary. It is intentionally pure: no database, no network, no
// filesystem, no environment access, and no side effects.
//
// Design constraints (approved 2026-11-08):
//   * D01–D10 are the complete first-release vocabulary.
//   * D02 and D09 remain finding codes; they are not R9/R10 durable classes.
//   * No rule may authorize an automatic repair.
//   * D06 (stale CONSUMING) is alert-only in the first release.
//
// A registry entry describes what evidence a rule may read and how a human must
// review it. It does not perform detection (WP04-02) or query a database
// (WP04-03), and it never grants a recovery action.

export const RULE_REGISTRY_VERSION = "wp04-rules-v1";

export const SEVERITY = Object.freeze({
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  INFO: "INFO",
});

export const CONFIDENCE = Object.freeze({
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
});

export const EVIDENCE_LEVELS = Object.freeze(["E0", "E1", "E2", "E3"]);

export const TASK_CREATION_POLICY = Object.freeze({
  DEFERRED: "DEFERRED",
  ALERT_ONLY: "ALERT_ONLY",
  PROHIBITED: "PROHIBITED",
});

export const ORDER_STATUSES = Object.freeze([
  "PENDING",
  "PREPARING",
  "READY",
  "SERVED",
  "PAYMENT_PENDING",
  "PAID",
  "CANCELLED",
  "ARCHIVED",
]);

export const RESERVATION_STATUSES = Object.freeze([
  "NO_INVENTORY",
  "RESERVED",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "CONSUMING",
  "CONSUMED",
  "RELEASED",
]);

const ANY_ORDER_STATUS = ORDER_STATUSES;
const ANY_RESERVATION_STATUS = RESERVATION_STATUSES;
const ABSENT_ALLOWED = Object.freeze([...RESERVATION_STATUSES, "ABSENT"]);

function freezeRule(rule) {
  // Deep-freeze every nested object and array. Object.freeze is shallow, and a
  // mutable nested severity object would let a caller change a rule at runtime.
  for (const value of Object.values(rule)) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(rule);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") deepFreeze(nested);
  }
  return Object.freeze(value);
}

/**
 * @typedef {Object} RuleSeverity
 * @property {string} level Default severity for a confirmed defect.
 * @property {string} min Lowest severity the rule may emit.
 * @property {string} max Highest severity the rule may emit.
 */

/**
 * @typedef {Object} RuleConfidence
 * @property {string} level Default confidence for a confirmed defect.
 * @property {string} min Lowest confidence the rule may emit.
 * @property {string} max Highest confidence the rule may emit.
 */

/**
 * @typedef {Object} RuleDefinition
 * @property {string} id Stable rule id ("D01" … "D10").
 * @property {string} version Registry entry version.
 * @property {string} title Short human title.
 * @property {string} description What divergence the rule describes.
 * @property {number} requiredClass The approved inconsistency class number.
 * @property {string} requiredClassLabel Human label for the class.
 * @property {ReadonlyArray<string>} recoveryMap Approved R-classes (never R9/R10).
 * @property {RuleSeverity} severity Default/possible severity.
 * @property {RuleConfidence} confidence Default/possible confidence.
 * @property {ReadonlyArray<string>} evidenceLevels Minimum evidence levels.
 * @property {Object} authoritativeSources Collection → allowed fields.
 * @property {Object} correlation Correlation identity.
 * @property {Object} lifecycle Lifecycle applicability.
 * @property {ReadonlyArray<string>} falsePositiveExclusions States that must not fire.
 * @property {Object} humanReview Review requirement and role placeholders.
 * @property {boolean} readOnly Always true.
 * @property {string} autoRecovery Always "PROHIBITED".
 * @property {boolean} createsRecoveryTask Always false in the first release.
 * @property {string} taskCreationPolicy DEFERRED or ALERT_ONLY.
 * @property {ReadonlyArray<string>} subCodes Stable finding sub-codes.
 */

/** @type {ReadonlyArray<RuleDefinition>} */
export const RULES = Object.freeze(
  [
    {
      id: "D01",
      version: "1.0.0",
      title: "PAID order with missing required stock deduction",
      description:
        "A PAID order whose inventory-linked requirement was not consumed exactly once, or whose reservation was released without a deduction.",
      requiredClass: 1,
      requiredClassLabel: "PAID order with missing required stock deduction",
      recoveryMap: Object.freeze(["R1", "R6"]),
      severity: { level: SEVERITY.CRITICAL, min: SEVERITY.CRITICAL, max: SEVERITY.CRITICAL },
      confidence: { level: CONFIDENCE.HIGH, min: CONFIDENCE.MEDIUM, max: CONFIDENCE.HIGH },
      evidenceLevels: Object.freeze(["E2"]),
      authoritativeSources: {
        orders: Object.freeze([
          "status",
          "paidAt",
          "paymentMethod",
          "items[].components[].inventoryItemId",
          "items[].components[].quantity",
          "items[].components[].stockQuantity",
        ]),
        inventoryreservations: Object.freeze([
          "status",
          "items[].inventoryItemId",
          "items[].requiredQuantity",
          "items[].reservedQuantity",
          "items[].shortageQuantity",
          "items[].consumedQuantity",
          "consumedAt",
          "releasedAt",
          "releaseReason",
        ]),
        stockmovements: Object.freeze([
          "reason",
          "refOrderId",
          "item",
          "quantity",
          "idempotencyKey",
          "voidedAt",
        ]),
      },
      correlation: {
        primary: "orderId",
        itemLevel: "(orderId, inventoryItemId)",
        idempotencyKey: "sale:<orderId>:<item>",
      },
      lifecycle: {
        appliesTo: "Paid orders with a settled payment marker.",
        orderStatuses: Object.freeze(["PAID"]),
        reservationStatuses: ABSENT_ALLOWED,
        notes:
          "Inventory-free orders, legacy deductions, approved shortages, and records inside the active grace window are INFO, not defects.",
      },
      falsePositiveExclusions: Object.freeze([
        "Order has no inventory-linked requirement.",
        "Legacy SaleDeduction exists without a reservation.",
        "Approved shortage explains a lower consumed quantity.",
        "Consumption is still inside the active transaction/grace window.",
        "Order is not PAID.",
      ]),
      humanReview: {
        required: true,
        roles: Object.freeze(["ROLE-INVENTORY-APPROVER", "ROLE-FINANCE-APPROVER"]),
        independentVerification: true,
      },
      readOnly: true,
      autoRecovery: "PROHIBITED",
      createsRecoveryTask: false,
      taskCreationPolicy: TASK_CREATION_POLICY.DEFERRED,
      subCodes: Object.freeze([
        "NO_INVENTORY_REQUIREMENT",
        "ALREADY_CORRECT_LEGACY",
        "APPROVED_SHORTAGE",
        "CONSUMED_WITHOUT_ITEM_EVIDENCE",
        "PAID_WITH_LIVE_RESERVATION",
        "PAID_RELEASED_NO_DEDUCTION",
        "PAID_NO_RESERVATION_NO_DEDUCTION",
      ]),
    },
    {
      id: "D02",
      version: "1.0.0",
      title: "Stock deduction without payment or accounting evidence",
      description:
        "A SaleDeduction whose order lifecycle cannot explain the consumption, including terminal orders with no valid void.",
      requiredClass: 2,
      requiredClassLabel: "Deduction without payment/accounting evidence",
      recoveryMap: Object.freeze(["R7"]),
      severity: { level: SEVERITY.HIGH, min: SEVERITY.HIGH, max: SEVERITY.CRITICAL },
      confidence: { level: CONFIDENCE.MEDIUM, min: CONFIDENCE.MEDIUM, max: CONFIDENCE.HIGH },
      evidenceLevels: Object.freeze(["E2"]),
      authoritativeSources: {
        stockmovements: Object.freeze([
          "refOrderId",
          "reason",
          "quantity",
          "item",
          "voidedAt",
          "voidReason",
          "idempotencyKey",
        ]),
        orders: Object.freeze([
          "status",
          "paidAt",
          "paymentMethod",
          "preparingAt",
          "kitchenStatus",
          "baristaStatus",
          "hotDrinkStatus",
        ]),
        inventoryreservations: Object.freeze(["status", "voids"]),
      },
      correlation: {
        primary: "orderId",
        itemLevel: "(orderId, inventoryItemId)",
        idempotencyKey: "sale:<orderId>:<item>",
      },
      lifecycle: {
        appliesTo: "Orders with at least one effective SaleDeduction.",
        orderStatuses: Object.freeze([
          "PENDING",
          "PREPARING",
          "READY",
          "SERVED",
          "PAYMENT_PENDING",
          "CANCELLED",
          "ARCHIVED",
        ]),
        reservationStatuses: ABSENT_ALLOWED,
        notes:
          "PAID orders are D01's domain and are excluded to avoid double-reporting. Never require PAID; prep consumption is legitimate.",
      },
      falsePositiveExclusions: Object.freeze([
        "Normal PREPARING consumption without payment.",
        "Whole-order cancellation with a valid void or reclassification.",
        "PAID order (reported under D01, not D02).",
        "Legacy archived deduction before the reservation model.",
        "Correction or Initial movements.",
      ]),
      humanReview: {
        required: true,
        roles: Object.freeze(["ROLE-FINANCE-APPROVER", "ROLE-INVENTORY-APPROVER"]),
        independentVerification: true,
      },
      readOnly: true,
      autoRecovery: "PROHIBITED",
      createsRecoveryTask: false,
      taskCreationPolicy: TASK_CREATION_POLICY.DEFERRED,
      durableClass: false,
      findingCodeOnly: true,
      subCodes: Object.freeze([
        "ORPHAN_DEDUCTION",
        "DEDUCTION_WITHOUT_PREPARATION_OR_PAYMENT",
        "TERMINAL_DEDUCTION_NO_VOID",
        "UNKNOWN_LIFECYCLE_DEDUCTION",
        "LEGACY_DEDUCTION",
      ]),
    },
    {
      id: "D03",
      version: "1.0.0",
      title: "Duplicate stock movements",
      description:
        "More than one effective SaleDeduction for the same order/item, or a duplicated idempotency identity.",
      requiredClass: 3,
      requiredClassLabel: "Duplicate stock movements",
      recoveryMap: Object.freeze(["R5"]),
      severity: { level: SEVERITY.CRITICAL, min: SEVERITY.CRITICAL, max: SEVERITY.CRITICAL },
      confidence: { level: CONFIDENCE.HIGH, min: CONFIDENCE.HIGH, max: CONFIDENCE.HIGH },
      evidenceLevels: Object.freeze(["E2"]),
      authoritativeSources: {
        stockmovements: Object.freeze([
          "refOrderId",
          "item",
          "reason",
          "voidedAt",
          "quantity",
          "idempotencyKey",
          "createdAt",
        ]),
      },
      correlation: {
        primary: "(refOrderId, item, effectiveReason)",
        itemLevel: "(orderId, inventoryItemId)",
        idempotencyKey: "sale:<orderId>:<item>",
      },
      lifecycle: {
        appliesTo: "Any order with stock movements.",
        orderStatuses: ANY_ORDER_STATUS,
        reservationStatuses: ANY_RESERVATION_STATUS,
        notes:
          "A legitimate duplicate is possible only for reasons other than double consumption. Deployed uniqueness is unverified.",
      },
      falsePositiveExclusions: Object.freeze([
        "One movement reclassified from SaleDeduction to Waste.",
        "Repeated Correction rows with distinct context.",
        "Index absence alone is not corruption; report INDEX_ABSENT_SUSPECTED.",
      ]),
      humanReview: {
        required: true,
        roles: Object.freeze([
          "ROLE-INVENTORY-APPROVER",
          "ROLE-FINANCE-APPROVER",
          "ROLE-DBA",
        ]),
        independentVerification: true,
      },
      readOnly: true,
      autoRecovery: "PROHIBITED",
      createsRecoveryTask: false,
      taskCreationPolicy: TASK_CREATION_POLICY.DEFERRED,
      subCodes: Object.freeze([
        "DUPLICATE_MOVEMENT_IDENTITY",
        "DUPLICATE_IDEMPOTENCY_KEY",
        "MALFORMED_SALE_KEY",
        "INDEX_ABSENT_SUSPECTED",
      ]),
    },
    {
      id: "D04",
      version: "1.0.0",
      title: "Duplicate or inconsistent reservations",
      description:
        "Multiple reservations for one order, orphan reservations, or a reservation whose status contradicts its held/consumed quantities.",
      requiredClass: 4,
      requiredClassLabel: "Duplicate or inconsistent reservations",
      recoveryMap: Object.freeze(["R5", "R7"]),
      severity: { level: SEVERITY.CRITICAL, min: SEVERITY.HIGH, max: SEVERITY.CRITICAL },
      confidence: { level: CONFIDENCE.HIGH, min: CONFIDENCE.MEDIUM, max: CONFIDENCE.HIGH },
      evidenceLevels: Object.freeze(["E2"]),
      authoritativeSources: {
        inventoryreservations: Object.freeze([
          "orderId",
          "orderNumber",
          "status",
          "items",
          "approval",
          "requirementFingerprint",
          "shortageFingerprint",
          "consumedAt",
          "releasedAt",
          "voids",
        ]),
        orders: Object.freeze(["_id", "orderNumber", "status"]),
      },
      correlation: {
        primary: "orderId",
        itemLevel: "(orderId, inventoryItemId)",
        idempotencyKey: null,
      },
      lifecycle: {
        appliesTo: "Any order with a reservation document.",
        orderStatuses: ANY_ORDER_STATUS,
        reservationStatuses: ANY_RESERVATION_STATUS,
        notes:
          "APPROVAL_REQUIRED is a deliberate blocked state, reported at INFO until the stale threshold is approved.",
      },
      falsePositiveExclusions: Object.freeze([
        "Concurrent reservation creation inside the edit grace window.",
        "NO_INVENTORY reservation with zero items.",
        "APPROVED status with a valid approval snapshot.",
        "APPROVAL_REQUIRED awaiting manager action.",
      ]),
      humanReview: {
        required: true,
        roles: Object.freeze(["ROLE-INVENTORY-APPROVER", "ROLE-DBA"]),
        independentVerification: true,
      },
      readOnly: true,
      autoRecovery: "PROHIBITED",
      createsRecoveryTask: false,
      taskCreationPolicy: TASK_CREATION_POLICY.DEFERRED,
      subCodes: Object.freeze([
        "DUPLICATE_RESERVATION",
        "ORPHAN_RESERVATION",
        "CONSUMED_WITHOUT_EVIDENCE",
        "RELEASED_WITH_HOLD",
        "APPROVED_WITHOUT_APPROVAL",
        "APPROVAL_FINGERPRINT_MISMATCH",
        "CONSUMED_EXCEEDS_REQUIRED",
        "NEGATIVE_RESERVATION_QUANTITY",
        "MISSING_INVENTORY_ITEM",
        "AWAITING_APPROVAL",
      ]),
    },
    {
      id: "D05",
      version: "1.0.0",
      title: "Expired or abandoned reservations",
      description:
        "A live hold on a terminal or paid order, an orphan hold, or a stale live hold. Reported only; never released on age alone.",
      requiredClass: 5,
      requiredClassLabel: "Expired/abandoned reservations",
      recoveryMap: Object.freeze(["R2", "R7"]),
      severity: { level: SEVERITY.HIGH, min: SEVERITY.MEDIUM, max: SEVERITY.HIGH },
      confidence: { level: CONFIDENCE.HIGH, min: CONFIDENCE.MEDIUM, max: CONFIDENCE.HIGH },
      evidenceLevels: Object.freeze(["E2"]),
      authoritativeSources: {
        inventoryreservations: Object.freeze([
          "status",
          "items[].reservedQuantity",
          "updatedAt",
          "decisionAt",
        ]),
        orders: Object.freeze(["status", "createdAt", "updatedAt", "paidAt"]),
        inventoryitems: Object.freeze(["reservedStock"]),
      },
      correlation: {
        primary: "orderId",
        itemLevel: "(orderId, inventoryItemId)",
        idempotencyKey: null,
      },
      lifecycle: {
        appliesTo: "Orders with a live hold, including terminal and paid orders.",
        orderStatuses: ANY_ORDER_STATUS,
        reservationStatuses: Object.freeze(["NO_INVENTORY", "RESERVED", "APPROVAL_REQUIRED", "APPROVED"]),
        notes:
          "Release requires terminal/abandoned status, no active line, arithmetic agreement, named approval, and the existing primitive. Age alone is never sufficient.",
      },
      falsePositiveExclusions: Object.freeze([
        "A long-lived legitimate hold.",
        "APPROVAL_REQUIRED is a deliberate blocked state.",
        "Release is already in flight.",
        "Compare reservedStock, not requiredQuantity.",
      ]),
      humanReview: {
        required: true,
        roles: Object.freeze(["ROLE-INVENTORY-APPROVER"]),
        independentVerification: true,
      },
      readOnly: true,
      autoRecovery: "PROHIBITED",
      createsRecoveryTask: false,
      taskCreationPolicy: TASK_CREATION_POLICY.DEFERRED,
      subCodes: Object.freeze([
        "ORPHAN_LIVE_HOLD",
        "HOLD_ON_TERMINAL_ORDER",
        "PAID_WITH_LIVE_HOLD",
        "STALE_LIVE_HOLD",
      ]),
    },
    {
      id: "D06",
      version: "1.0.0",
      title: "Orders stuck in CONSUMING",
      description:
        "A reservation left in CONSUMING beyond the approved threshold. Alert-only in the first release.",
      requiredClass: 6,
      requiredClassLabel: "Stuck CONSUMING",
      recoveryMap: Object.freeze(["R3"]),
      severity: { level: SEVERITY.CRITICAL, min: SEVERITY.HIGH, max: SEVERITY.CRITICAL },
      confidence: { level: CONFIDENCE.HIGH, min: CONFIDENCE.HIGH, max: CONFIDENCE.HIGH },
      evidenceLevels: Object.freeze(["E2"]),
      authoritativeSources: {
        inventoryreservations: Object.freeze([
          "status",
          "updatedAt",
          "items",
          "consumedAt",
        ]),
        stockmovements: Object.freeze(["refOrderId", "item", "quantity", "reason", "voidedAt"]),
        inventoryitems: Object.freeze(["currentStock", "reservedStock"]),
      },
      correlation: {
        primary: "orderId",
        itemLevel: "(orderId, inventoryItemId)",
        idempotencyKey: "sale:<orderId>:<item>",
      },
      lifecycle: {
        appliesTo: "Reservations currently in CONSUMING.",
        orderStatuses: ANY_ORDER_STATUS,
        reservationStatuses: Object.freeze(["CONSUMING"]),
        notes:
          "The numeric W_STALE threshold is deferred and owner-supplied. Until then the rule reports ALERT_ONLY and creates no task.",
      },
      falsePositiveExclusions: Object.freeze([
        "Age is below the approved stale threshold (threshold deferred).",
        "The movement is a voided or Waste row.",
        "The transaction is still inside the approved transaction budget.",
      ]),
      humanReview: {
        required: true,
        roles: Object.freeze(["ROLE-INVENTORY-APPROVER", "ROLE-TECHNICAL-LEAD"]),
        independentVerification: true,
      },
      readOnly: true,
      autoRecovery: "PROHIBITED",
      createsRecoveryTask: false,
      taskCreationPolicy: TASK_CREATION_POLICY.ALERT_ONLY,
      subCodes: Object.freeze([
        "CONSUMING_ORPHAN",
        "CONSUMING_MOVEMENTS_COMPLETE",
        "CONSUMING_PARTIAL",
        "CONSUMING_ABANDONED",
        "CONSUMING_AMBIGUOUS",
      ]),
    },
    {
      id: "D07",
      version: "1.0.0",
      title: "Partial multi-station stock deductions",
      description:
        "A consumed reservation whose movement totals do not match, or a movement for an item the reservation never held.",
      requiredClass: 7,
      requiredClassLabel: "Partial multi-station deductions",
      recoveryMap: Object.freeze(["R4", "R6"]),
      severity: { level: SEVERITY.HIGH, min: SEVERITY.HIGH, max: SEVERITY.CRITICAL },
      confidence: { level: CONFIDENCE.HIGH, min: CONFIDENCE.MEDIUM, max: CONFIDENCE.HIGH },
      evidenceLevels: Object.freeze(["E2"]),
      authoritativeSources: {
        orders: Object.freeze([
          "items[].type",
          "items[].quantity",
          "items[].cancelled",
          "items[].components",
          "kitchenStatus",
          "baristaStatus",
          "hotDrinkStatus",
        ]),
        inventoryreservations: Object.freeze(["status", "items"]),
        stockmovements: Object.freeze(["refOrderId", "item", "quantity", "reason", "voidedAt"]),
      },
      correlation: {
        primary: "orderId",
        itemLevel: "(orderId, inventoryItemId)",
        idempotencyKey: "sale:<orderId>:<item>",
      },
      lifecycle: {
        appliesTo: "Orders whose reservation is consuming or consumed.",
        orderStatuses: Object.freeze([
          "PREPARING",
          "READY",
          "SERVED",
          "PAYMENT_PENDING",
          "PAID",
        ]),
        reservationStatuses: Object.freeze(["CONSUMING", "CONSUMED"]),
        notes:
          "Compare item totals, never per-line allocation. Mandatory line-level reconciliation is deferred.",
      },
      falsePositiveExclusions: Object.freeze([
        "Whole order consumed once at the first station by design.",
        "Approved shortage explains a lower consumed quantity.",
        "An item is shared across active lines.",
      ]),
      humanReview: {
        required: true,
        roles: Object.freeze(["ROLE-INVENTORY-APPROVER", "ROLE-OPERATIONS"]),
        independentVerification: true,
      },
      readOnly: true,
      autoRecovery: "PROHIBITED",
      createsRecoveryTask: false,
      taskCreationPolicy: TASK_CREATION_POLICY.DEFERRED,
      subCodes: Object.freeze([
        "CONSUMED_MOVEMENT_MISMATCH",
        "REQUIRED_ITEM_NOT_CONSUMED",
        "MOVEMENT_WITHOUT_RESERVATION_ITEM",
        "STATION_PARTIAL_CONSUMPTION",
      ]),
    },
    {
      id: "D08",
      version: "1.0.0",
      title: "Cancelled items with inconsistent inventory state",
      description:
        "A cancelled/archived order whose sale deduction was not reclassified, whose hold was not released, or whose cancelled line has no void.",
      requiredClass: 8,
      requiredClassLabel: "Cancelled items with inconsistent inventory",
      recoveryMap: Object.freeze(["R5", "R7"]),
      severity: { level: SEVERITY.HIGH, min: SEVERITY.MEDIUM, max: SEVERITY.HIGH },
      confidence: { level: CONFIDENCE.HIGH, min: CONFIDENCE.MEDIUM, max: CONFIDENCE.HIGH },
      evidenceLevels: Object.freeze(["E2"]),
      authoritativeSources: {
        orders: Object.freeze([
          "status",
          "items[].cancelled",
          "items[].lineId",
          "items[].cancelledAt",
        ]),
        inventoryreservations: Object.freeze([
          "status",
          "voids",
          "items[].reservedQuantity",
        ]),
        stockmovements: Object.freeze(["reason", "voidedAt", "voidReason"]),
      },
      correlation: {
        primary: "orderId",
        itemLevel: "(orderId, lineId) where safe",
        idempotencyKey: "sale:<orderId>:<item>",
      },
      lifecycle: {
        appliesTo: "Cancelled or archived orders, and cancelled lines.",
        orderStatuses: Object.freeze(["CANCELLED", "ARCHIVED"]),
        reservationStatuses: Object.freeze([
          "NO_INVENTORY",
          "RESERVED",
          "APPROVAL_REQUIRED",
          "APPROVED",
          "CONSUMING",
          "CONSUMED",
          "RELEASED",
        ]),
        notes:
          "Accept ORDER or ARCHIVE sources for a whole-order void. Never release an item based on one cancelled line.",
      },
      falsePositiveExclusions: Object.freeze([
        "Cancellation retry is in flight.",
        "Whole-order void uses the ARCHIVE source.",
        "An item is shared with an active line.",
      ]),
      humanReview: {
        required: true,
        roles: Object.freeze(["ROLE-INVENTORY-APPROVER", "ROLE-OPERATIONS"]),
        independentVerification: true,
      },
      readOnly: true,
      autoRecovery: "PROHIBITED",
      createsRecoveryTask: false,
      taskCreationPolicy: TASK_CREATION_POLICY.DEFERRED,
      subCodes: Object.freeze([
        "CANCELLED_NO_ORDER_VOID",
        "CANCELLED_SALE_NOT_RECLASSIFIED",
        "CANCELLED_HOLD_NOT_RELEASED",
        "LINE_CANCEL_NO_VOID",
        "LINE_CANCEL_HOLD_NOT_RECONCILED",
        "DUPLICATE_VOID",
      ]),
    },
    {
      id: "D09",
      version: "1.0.0",
      title: "Payment verification/rejection with inconsistent stock state",
      description:
        "A payment workflow contradiction or a prepared order with a live hold. Finding-only; never an automatic correction.",
      requiredClass: 9,
      requiredClassLabel: "Payment verification/rejection inconsistency",
      recoveryMap: Object.freeze(["R1", "R7"]),
      severity: { level: SEVERITY.HIGH, min: SEVERITY.HIGH, max: SEVERITY.CRITICAL },
      confidence: { level: CONFIDENCE.MEDIUM, min: CONFIDENCE.MEDIUM, max: CONFIDENCE.HIGH },
      evidenceLevels: Object.freeze(["E2"]),
      authoritativeSources: {
        orders: Object.freeze([
          "status",
          "paymentMethod",
          "paymentAccountId",
          "paymentAccountSnapshot",
          "paymentSubmittedAt",
          "paymentSubmittedBy",
          "paymentVerifiedAt",
          "paymentVerifiedBy",
          "paymentRejectedAt",
          "paymentRejectedBy",
          "paymentRejectionReason",
          "paidAt",
          "preparingAt",
          "kitchenStatus",
          "baristaStatus",
          "hotDrinkStatus",
        ]),
        inventoryreservations: Object.freeze(["status", "items", "consumedAt"]),
        stockmovements: Object.freeze(["refOrderId", "item", "quantity", "reason"]),
      },
      correlation: {
        primary: "orderId",
        itemLevel: "(orderId, inventoryItemId)",
        idempotencyKey: null,
      },
      lifecycle: {
        appliesTo: "Orders in a payment workflow state.",
        orderStatuses: Object.freeze([
          "PREPARING",
          "READY",
          "SERVED",
          "PAYMENT_PENDING",
          "PAID",
        ]),
        reservationStatuses: ANY_RESERVATION_STATUS,
        notes:
          "Normal post-prep payment pending is expected. Do not model a stock change from verification or rejection.",
      },
      falsePositiveExclusions: Object.freeze([
        "Normal PAYMENT_PENDING after preparation.",
        "Cash payment without verification fields.",
        "Archived account resolved through a snapshot.",
        "Rejected payment with already-consumed stock.",
      ]),
      humanReview: {
        required: true,
        roles: Object.freeze(["ROLE-FINANCE-APPROVER", "ROLE-INVENTORY-APPROVER"]),
        independentVerification: true,
      },
      readOnly: true,
      autoRecovery: "PROHIBITED",
      createsRecoveryTask: false,
      taskCreationPolicy: TASK_CREATION_POLICY.DEFERRED,
      durableClass: false,
      findingCodeOnly: true,
      subCodes: Object.freeze([
        "PENDING_WITHOUT_SUBMISSION",
        "PENDING_WITH_PAID_AT",
        "PENDING_WITH_VERIFICATION",
        "PENDING_AFTER_REJECTION",
        "PAID_WITHOUT_PAID_AT",
        "PAID_WITHOUT_METHOD",
        "PAID_TRANSFER_WITHOUT_ACCOUNT",
        "PAID_WITH_REJECTION_TIMESTAMP",
        "PREPARED_WITH_LIVE_HOLD",
        "VERIFIED_NOT_PAID",
      ]),
    },
    {
      id: "D10",
      version: "1.0.0",
      title: "Missing, malformed, or conflicting recovery evidence",
      description:
        "An unknown enum, invalid type, impossible quantity, orphan reference, contradictory timestamp, or evidence drift.",
      requiredClass: 10,
      requiredClassLabel: "Missing/malformed/conflicting evidence",
      recoveryMap: Object.freeze(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]),
      severity: { level: SEVERITY.HIGH, min: SEVERITY.HIGH, max: SEVERITY.CRITICAL },
      confidence: { level: CONFIDENCE.HIGH, min: CONFIDENCE.MEDIUM, max: CONFIDENCE.HIGH },
      evidenceLevels: Object.freeze(["E1", "E2"]),
      authoritativeSources: {
        all: Object.freeze([
          "every field used by D01–D09",
          "schema enums",
          "type expectations",
        ]),
      },
      correlation: {
        primary: "orderId",
        itemLevel: "(orderId, inventoryItemId)",
        idempotencyKey: "taskId, evidenceFingerprint",
      },
      lifecycle: {
        appliesTo: "Every scanned order, reservation, movement, and inventory item.",
        orderStatuses: ANY_ORDER_STATUS,
        reservationStatuses: ABSENT_ALLOWED,
        notes:
          "Never guess a missing value. Absent optional legacy fields are LEGACY_SHAPE at INFO, not errors.",
      },
      falsePositiveExclusions: Object.freeze([
        "Newer optional fields absent on legacy documents (LEGACY_SHAPE).",
        "Transient mid-transaction state inside the active window.",
        "Decimal precision handled with the project epsilon policy.",
        "Unknown future fields reported as UNKNOWN_SHAPE, never reinterpreted.",
      ]),
      humanReview: {
        required: true,
        roles: Object.freeze(["ROLE-TECHNICAL-LEAD", "ROLE-DATA-OWNER"]),
        independentVerification: true,
      },
      readOnly: true,
      autoRecovery: "PROHIBITED",
      createsRecoveryTask: false,
      taskCreationPolicy: TASK_CREATION_POLICY.DEFERRED,
      subCodes: Object.freeze([
        "UNKNOWN_ENUM",
        "MISSING_REQUIRED_FIELD",
        "INVALID_TYPE",
        "NEGATIVE_QUANTITY",
        "QUANTITY_OUT_OF_RANGE",
        "ORPHAN_REFERENCE",
        "IDENTITY_MISMATCH",
        "CONTRADICTORY_TIMESTAMPS",
        "EVIDENCE_DRIFT",
        "UNKNOWN_SHAPE",
        "LEGACY_SHAPE",
        "EVIDENCE_INCOMPLETE",
      ]),
    },
  ].map(freezeRule),
);

// Null-prototype map: a lookup such as RULES_BY_ID["__proto__"] must not resolve
// to Object.prototype, and no caller-supplied key may create a rule.
const registryMap = Object.create(null);
for (const rule of RULES) registryMap[rule.id] = rule;

/** @type {Readonly<Record<string, RuleDefinition>>} */
export const RULES_BY_ID = Object.freeze(registryMap);

export const RULE_IDS = Object.freeze(RULES.map((rule) => rule.id));

/**
 * Return the frozen definition for a stable rule id.
 *
 * Unknown ids return null. This function never creates a rule from caller input;
 * the only vocabulary is the frozen RULES array above.
 *
 * @param {string} id
 * @returns {RuleDefinition | null}
 */
export function getRuleDefinition(id) {
  if (typeof id !== "string") return null;
  if (!Object.hasOwn(RULES_BY_ID, id)) return null;
  return RULES_BY_ID[id];
}

/**
 * Return every R-class referenced by the registry (for EXACT set checks).
 * R9/R10 must never appear.
 *
 * @returns {ReadonlyArray<string>}
 */
export function getReferencedRecoveryClasses() {
  const classes = new Set();
  for (const rule of RULES) {
    for (const entry of rule.recoveryMap) classes.add(entry);
  }
  return Object.freeze([...classes].sort());
}
