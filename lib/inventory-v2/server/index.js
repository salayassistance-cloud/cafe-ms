// BONO Inventory V2 — server-only barrel.
//
// This barrel is intentionally NOT imported by any production route, V1 service,
// model, or client component in Phase 2.0. It exists so future server modules
// have one explicit entry point and so static tests can prove that the public
// domain barrel remains issuer-free.
//
// Never re-export trusted issuers (`issueManagerActionAuthorization`,
// `issueWasteManagerAuthorization`) or the test-only
// `resetWasteCorrectionLedger` here. Server-side Manager verification and
// durable challenge consumption are Phase 2.1 concerns and must be designed
// separately.

export {
  INVENTORY_V2_SERVER_MODULE_PREFIX,
  assertServerOnly,
  isServerOnlyViolation,
  isServerRuntime,
} from "./boundary.js";

export {
  TRANSACTION_ERROR_CODES,
  UNKNOWN_COMMIT_RESOLUTIONS,
  InventoryV2TransactionError,
  classifyTransactionError,
  computeBackoffMs,
  isTransactionsUnsupportedError,
  isTransientTransactionError,
  isUnknownTransactionCommitResult,
  runV2Transaction,
} from "./transaction.js";

export {
  V2_COLLECTIONS,
  V2_FORBIDDEN_CHALLENGE_UNIQUE_KEY,
  V2_INDEX_CLASSIFICATIONS,
  V2_INDEX_PLAN,
  InventoryV2IndexPlanError,
  assertV2IndexPlan,
  getV2IndexPlan,
  indexKeySignature,
  planEntriesForCollection,
  validateV2IndexPlan,
} from "./indexPlan.js";

export {
  CANCEL_ORDER_ITEM_UPDATED_AT_ANALYSIS,
  ORDER_MUTATION_INVENTORY,
  ORDER_MUTATION_TYPES,
  ORDER_MUTATION_VERIFICATION,
  ORDER_VERSION_CONTRACT,
  UNVERIFIED_WRITER_RISKS,
  InventoryV2OrderInventoryError,
  assertOrderMutationInventory,
  findOrderMutationPath,
  getOrderMutationInventory,
  validateOrderMutationInventory,
} from "./orderMutationInventory.js";

export {
  CLEAR_ORDERS_RISK,
  CUTOVER_OWNER_DECISIONS,
  INVENTORY_MODES,
  INVENTORY_OWNERSHIP,
  INVENTORY_OWNERSHIP_ERRORS,
  RESERVED_STOCK_OPERATIONS,
  RESERVED_STOCK_WRITERS,
  SHARED_STOCK_COLLECTION,
  SHARED_STOCK_FIELD,
  SHARED_STOCK_INVARIANTS,
  InventoryV2OwnershipError,
  assertClearOrdersV2Safe,
  assertExactlyOneInventoryOwner,
  assertInventoryOwner,
  assertV1OwnedOrder,
  assertV2OwnedOrder,
  evaluateClearOrdersSafety,
  normalizeInventoryMode,
  resolveInventoryOwner,
} from "./ownership.js";
