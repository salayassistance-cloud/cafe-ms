// BONO Inventory V2 — pure domain barrel.
//
// IMPORTANT: this barrel is intentionally NOT imported by any V1 service,
// API route, model, or UI. It has no database, Mongoose, or framework imports.
//
// P1-06 / P2-04: trusted-issuance helpers (`issueManagerActionAuthorization`,
// `issueWasteManagerAuthorization`) and the test-only
// `resetWasteCorrectionLedger` are deliberately NOT exported here. They are not
// production authentication boundaries and must never be reachable from the
// public domain surface. Phase 2 owns server-only Manager verification and
// durable one-time challenge consumption.

export {
  ERROR_CODES,
  InventoryV2DomainError,
  domainError,
  fail,
  isDomainError,
} from "./errors.js";

export {
  CANONICAL_STATIONS,
  INVENTORY_STATES,
  INVENTORY_STATE_VALUES,
  KDS_STATES,
  KDS_STATE_VALUES,
  COMPLETION_REASONS,
  TERMINAL_INVENTORY_STATES,
  ACTIVE_INVENTORY_STATES,
  WASTE_CLASSES,
  isCanonicalStation,
  isInventoryState,
  isTerminalInventoryState,
} from "./states.js";

export {
  QTY_SCALE_DIGITS,
  QTY_SCALE,
  MAX_SCALED_QUANTITY,
  EXACT_QUANTITY_ERRORS,
  parseScaledQuantity,
  assertScaledQuantity,
  assertSignedScaledQuantity,
  assertPositiveScaledQuantity,
  assertQuantity,
  assertSignedQuantity,
  assertNonNegativeInteger,
  assertPositiveInteger,
  formatScaledQuantity,
  scaledToNumber,
  addScaledQuantities,
  subtractScaledQuantities,
  compareScaledQuantities,
  scaledQuantitiesEqual,
  nearlyEqual,
  round3,
  addQuantities,
  subtractQuantities,
} from "./quantity.js";

export {
  ALLOCATION_TUPLE_VERSION,
  ALLOCATION_KEY_PREFIX,
  ALLOCATION_ID_PREFIX,
  ALLOCATION_IDENTITY_KINDS,
  buildAllocationIdentity,
  buildAllocationKeyFromTuple,
  buildAllocationIdForKey,
  assertAllocationIdentityConsistency,
  assertUniqueAllocationIds,
  compareAllocationOrder,
  sortAllocations,
} from "./allocationIdentity.js";

export {
  ACCOUNTING_FIELDS,
  accountingExact,
  validateAllocationAccounting,
  deriveShortage,
  equationHolds,
  initialReservation,
  consumeFull,
  assertShortageConsumptionBinding,
  consumeApprovedShortage,
  releaseHold,
  voidShortage,
  cancelPreStart,
  cancelPostStart,
  archiveBeforePreparation,
  archivePreparedUnsold,
  reclassifyWaste,
  validateQuantityRevision,
  validateTopUpEpoch,
  assertNoAccountingChange,
} from "./accounting.js";

export {
  INVENTORY_EVENTS,
  STATE_EVIDENCE_ERRORS,
  nextInventoryState,
  canTransitionInventory,
  assertKdsReadyAllowed,
  normalizeKdsState,
  hasActiveKdsTicket,
} from "./stateMachine.js";

export {
  APPROVAL_CHALLENGE_TTL_MS,
  HIGH_VALUE_EVALUATION_TTL_MS,
  APPROVAL_STAGES,
  APPROVAL_EVIDENCE_VERSION,
  HIGH_VALUE_EVALUATION_VERSION,
  MANAGER_ACTION_AUTHORIZATION_VERSION,
  MANAGER_ACTION_TYPES,
  evaluateHighValue,
  assertTrustedHighValueEvaluation,
  validateApprovalSnapshot,
  assertApprovalEvidence,
  isValidatedApprovalEvidence,
  assertManagerActionAuthorization,
} from "./approval.js";

export {
  CANONICAL_ACCOUNTING_UNITS,
  APPROVED_UNITS,
  UNIT_DEFINITIONS,
  SUPPORTED_UNIT_PAIRS,
  assertApprovedUnit,
  assertCanonicalAccountingUnit,
  getConversionFactorExact,
  getConversionFactor,
  isSupportedConversion,
  parseQuantityInUnit,
  formatQuantityInUnit,
  convertQuantityExact,
  convertQuantity,
  convertQuantityForAccounting,
  EXACT_QUANTITY_WIRE_VERSION,
  EXACT_SIGNED_QUANTITY_WIRE_VERSION,
  serializeExactQuantity,
  deserializeExactQuantity,
  serializeSignedExactQuantity,
  deserializeSignedExactQuantity,
} from "./units.js";

export {
  WASTE_AUTHORIZATION_VERSION,
  WASTE_AUTHORIZATION_TTL_MS,
  computeWasteAccounting,
  splitWaste,
  computeWasteCorrectionFingerprint,
  validateWasteCorrection,
  applyWasteCorrection,
  assertWasteAuthorizationEvidence,
} from "./waste.js";

export {
  PAYABLE_ORDER_STATUSES,
  STATION_EVIDENCE_SOURCES,
  KDS_EVIDENCE_SOURCES,
  PAYMENT_EVIDENCE_ERRORS,
  evaluatePaymentReadiness,
  isPaymentReady,
  assertPaymentReady,
} from "./paymentReadiness.js";
