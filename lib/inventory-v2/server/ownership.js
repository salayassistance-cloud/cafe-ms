// BONO Inventory V2 — V1/V2 inventory ownership readiness.
//
// Phase 2.0 does NOT add `inventoryMode` to the Order schema, does NOT change
// V1 reservation/release/consumption/payment/stock behaviour, and does NOT
// migrate or cut over any order. This module is the pure ownership contract that
// future services must enforce.
//
// Ownership model
// ---------------
//   V1 order -> inventoryreservations (InventoryReservation) is the authority.
//   V2 order -> inventory_v2_allocations is the proposed authority.
//   InventoryItem.reservedStock remains the SHARED physical hold aggregate.
//
// An order must have EXACTLY ONE inventory owner. `inventoryMode` must be
// assigned server-side and enforced in services, never trusted from the UI.
// V1 services must reject V2-owned orders and vice versa.
//
// Shared aggregate rules
// ----------------------
//   * reservedStock is a physical hold, not an owner-specific ledger.
//   * A V1 release must never subtract a V2 hold (and vice versa).
//   * Every hold change must be a conditional atomic update inside a
//     transaction; read-then-unconditional-write is forbidden.
//   * Reconciliation is per-owner; a global reset is not reconciliation.
//   * No retroactive deduction may be applied to already-consumed stock.
//   * V1 and V2 reporting must remain isolated until an owner-approved cutover.

import { assertServerOnly } from "./boundary.js";

assertServerOnly("Inventory V2 ownership model");

export const INVENTORY_MODES = Object.freeze({
  V1: "V1",
  V2: "V2",
});

export const INVENTORY_OWNERSHIP = Object.freeze({
  V1: Object.freeze({
    mode: INVENTORY_MODES.V1,
    authorityCollection: "inventoryreservations",
    authorityModel: "InventoryReservation",
    status: "ACTIVE_V1",
  }),
  V2: Object.freeze({
    mode: INVENTORY_MODES.V2,
    authorityCollection: "inventory_v2_allocations",
    authorityModel: "InventoryV2Allocation",
    status: "PROPOSED_NOT_IMPLEMENTED",
  }),
});

export const SHARED_STOCK_COLLECTION = "inventoryitems";
export const SHARED_STOCK_FIELD = "reservedStock";

export const INVENTORY_OWNERSHIP_ERRORS = Object.freeze({
  MODE_REQUIRED: "INVENTORY_MODE_REQUIRED",
  MODE_INVALID: "INVENTORY_MODE_INVALID",
  OWNER_MISMATCH: "INVENTORY_OWNER_MISMATCH",
  MULTIPLE_OWNERS: "INVENTORY_MULTIPLE_OWNERS",
  NO_OWNER: "INVENTORY_NO_OWNER",
  V2_HOLDS_PRESENT: "CLEAR_ORDERS_V2_HOLDS_PRESENT",
  V1_CONSUMING: "CLEAR_ORDERS_V1_CONSUMPTION_IN_FLIGHT",
  V2_OWNERSHIP_UNKNOWN: "CLEAR_ORDERS_V2_OWNERSHIP_UNKNOWN",
});

export class InventoryV2OwnershipError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = "InventoryV2OwnershipError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function ownershipError(code, message, details) {
  return new InventoryV2OwnershipError(code, message, details);
}

export function normalizeInventoryMode(value) {
  if (value === undefined || value === null || value === "") {
    throw ownershipError(
      INVENTORY_OWNERSHIP_ERRORS.MODE_REQUIRED,
      "inventoryMode is required; ownership must never be inferred from the UI"
    );
  }
  const mode = String(value).trim().toUpperCase();
  if (mode !== INVENTORY_MODES.V1 && mode !== INVENTORY_MODES.V2) {
    throw ownershipError(
      INVENTORY_OWNERSHIP_ERRORS.MODE_INVALID,
      "inventoryMode must be V1 or V2",
      { inventoryMode: value }
    );
  }
  return mode;
}

export function resolveInventoryOwner({ inventoryMode } = {}) {
  const mode = normalizeInventoryMode(inventoryMode);
  return INVENTORY_OWNERSHIP[mode];
}

export function assertInventoryOwner(order, expectedMode) {
  const expected = normalizeInventoryMode(expectedMode);
  const actual = normalizeInventoryMode(order?.inventoryMode);
  if (actual !== expected) {
    throw ownershipError(
      INVENTORY_OWNERSHIP_ERRORS.OWNER_MISMATCH,
      `This operation requires a ${expected}-owned order`,
      {
        expectedMode: expected,
        actualMode: actual,
        orderId: order?._id ?? order?.id ?? null,
      }
    );
  }
  return actual;
}

export function assertV1OwnedOrder(order) {
  return assertInventoryOwner(order, INVENTORY_MODES.V1);
}

export function assertV2OwnedOrder(order) {
  return assertInventoryOwner(order, INVENTORY_MODES.V2);
}

/**
 * Exactly one owner per order. Both flags true or both false fail closed.
 */
export function assertExactlyOneInventoryOwner({
  orderId = null,
  v1Owned = false,
  v2Owned = false,
} = {}) {
  if (v1Owned === true && v2Owned === true) {
    throw ownershipError(
      INVENTORY_OWNERSHIP_ERRORS.MULTIPLE_OWNERS,
      "An order must not be owned by both V1 reservations and V2 allocations",
      { orderId }
    );
  }
  if (v1Owned !== true && v2Owned !== true) {
    throw ownershipError(
      INVENTORY_OWNERSHIP_ERRORS.NO_OWNER,
      "An order must have exactly one inventory owner",
      { orderId }
    );
  }
  return v1Owned === true ? INVENTORY_MODES.V1 : INVENTORY_MODES.V2;
}

// ---------------------------------------------------------------------------
// reservedStock writer/reader inventory
// ---------------------------------------------------------------------------

export const RESERVED_STOCK_OPERATIONS = Object.freeze({
  RESERVATION_CREATE: "RESERVATION_CREATE",
  RESERVATION_RECONCILE: "RESERVATION_RECONCILE",
  SHORTAGE_APPROVAL: "SHORTAGE_APPROVAL",
  RESERVATION_RELEASE: "RESERVATION_RELEASE",
  INVENTORY_CONSUMPTION: "INVENTORY_CONSUMPTION",
  WASTE_OPERATION: "WASTE_OPERATION",
  MANAGER_CLEAR_ORDERS: "MANAGER_CLEAR_ORDERS",
});

export const RESERVED_STOCK_WRITERS = Object.freeze([
  {
    file: "lib/inventoryReservationService.js",
    symbol: "ensureOrderInventoryReservation",
    operation: RESERVED_STOCK_OPERATIONS.RESERVATION_CREATE,
    writesReservedStock: true,
    readsReservedStock: true,
    ownershipScope: INVENTORY_MODES.V1,
    risk:
      "Creates V1 holds with a conditional $inc. Future V2 code must not call this for a V2-owned order.",
    verificationStatus: "VERIFIED_FROM_SOURCE",
  },
  {
    file: "lib/inventoryReservationService.js",
    symbol: "reconcileOrderInventory",
    operation: RESERVED_STOCK_OPERATIONS.RESERVATION_RECONCILE,
    writesReservedStock: true,
    readsReservedStock: true,
    ownershipScope: INVENTORY_MODES.V1,
    risk:
      "Adjusts existing V1 holds after line edits/cancellations. Must never reconcile a V2 allocation.",
    verificationStatus: "VERIFIED_FROM_SOURCE",
  },
  {
    file: "lib/inventoryReservationService.js",
    symbol: "releaseOrderInventory",
    operation: RESERVED_STOCK_OPERATIONS.RESERVATION_RELEASE,
    writesReservedStock: true,
    readsReservedStock: true,
    ownershipScope: INVENTORY_MODES.V1,
    risk:
      "Releases V1 holds. A V2 hold must never be released by this path.",
    verificationStatus: "VERIFIED_FROM_SOURCE",
  },
  {
    file: "lib/inventoryReservationService.js",
    symbol: "consumeOrderInventory",
    operation: RESERVED_STOCK_OPERATIONS.INVENTORY_CONSUMPTION,
    writesReservedStock: true,
    readsReservedStock: true,
    ownershipScope: INVENTORY_MODES.V1,
    risk:
      "Decrements currentStock and reservedStock together. Must never consume a V2 allocation.",
    verificationStatus: "VERIFIED_FROM_SOURCE",
  },
  {
    file: "app/api/manager/settings/clear-orders/route.js",
    symbol: "POST",
    operation: RESERVED_STOCK_OPERATIONS.MANAGER_CLEAR_ORDERS,
    writesReservedStock: true,
    readsReservedStock: true,
    ownershipScope: "GLOBAL",
    risk:
      "CRITICAL: updateMany({ reservedStock: { $gt: 0 } }, { $set: { reservedStock: 0 } }) erases every hold, including future V2 holds. Phase 2.0 does not change it.",
    verificationStatus: "VERIFIED_FROM_SOURCE",
  },
  {
    file: "lib/inventoryDeductionService.js",
    symbol: "executeInventoryDeduction",
    operation: RESERVED_STOCK_OPERATIONS.INVENTORY_CONSUMPTION,
    writesReservedStock: false,
    readsReservedStock: false,
    ownershipScope: "LEGACY_V1_DEDUCTION",
    risk:
      "Legacy planner/executor decrements currentStock only. It does not touch reservedStock; future V2 consumption must not reuse it.",
    verificationStatus: "VERIFIED_FROM_SOURCE",
  },
  {
    file: "lib/inventoryWasteService.js",
    symbol: "recordWaste",
    operation: RESERVED_STOCK_OPERATIONS.WASTE_OPERATION,
    writesReservedStock: false,
    readsReservedStock: true,
    ownershipScope: "SHARED_STOCK",
    risk:
      "Waste decrements currentStock and reads reservedStock for available-stock guards. It must remain owner-agnostic and must never release a hold.",
    verificationStatus: "VERIFIED_FROM_SOURCE",
  },
]);

export const SHARED_STOCK_INVARIANTS = Object.freeze([
  "reservedStock >= 0 at all times.",
  "availableStock = currentStock - reservedStock; availableStock must never be represented as negative reservedStock.",
  "An order has exactly one inventory owner: V1 InventoryReservation or V2 allocations, never both.",
  "Every hold change is a conditional atomic update; read-then-unconditional-write is forbidden.",
  "V1 release/consume paths must not subtract V2 holds, and V2 paths must not subtract V1 holds.",
  "Reconciliation is per-owner. A global reservedStock reset is not reconciliation.",
  "No retroactive deduction may be applied to already-consumed stock.",
  "V1 and V2 reporting must remain isolated until an owner-approved cutover.",
  "Manager clear-orders must not run while V2 holds exist or V2 ownership is unknown.",
]);

export const CLEAR_ORDERS_RISK = Object.freeze({
  file: "app/api/manager/settings/clear-orders/route.js",
  symbol: "POST",
  currentBehaviour: Object.freeze([
    "Order.deleteMany({}) deletes every order.",
    "V1 InventoryReservation documents are deleted except CONSUMED/CONSUMING.",
    "InventoryItem.updateMany({ reservedStock: { $gt: 0 } }, { $set: { reservedStock: 0 } }) globally resets holds when no V1 CONSUMING reservation exists.",
  ]),
  v2Risk:
    "A future V2 allocation hold would be erased by the global reset, leaving V2 allocations that believe stock is held while reservedStock is zero.",
  phase2Decision:
    "DOCUMENT ONLY. Do not change the current route in Phase 2.0.",
  futureGuard: Object.freeze([
    "Reject the reset when any V2 allocation hold exists.",
    "Reject the reset when V2 ownership is unknown/incompletely migrated.",
    "Recompute reservedStock from the surviving V1 and V2 owner ledgers instead of setting it to zero.",
    "Require an explicit owner-approved V2-aware maintenance procedure.",
  ]),
});

/**
 * Pure future-guard evaluation. The current route does not call this.
 */
export function evaluateClearOrdersSafety({
  v1ActiveHolds = 0,
  v1Consuming = 0,
  v2ActiveHolds = 0,
  v2OwnershipUnknown = false,
} = {}) {
  if (v2OwnershipUnknown === true) {
    return Object.freeze({
      allowed: false,
      code: INVENTORY_OWNERSHIP_ERRORS.V2_OWNERSHIP_UNKNOWN,
      requiresV2AwareProcedure: true,
    });
  }
  if (Number(v2ActiveHolds) > 0) {
    return Object.freeze({
      allowed: false,
      code: INVENTORY_OWNERSHIP_ERRORS.V2_HOLDS_PRESENT,
      requiresV2AwareProcedure: true,
    });
  }
  if (Number(v1Consuming) > 0) {
    return Object.freeze({
      allowed: false,
      code: INVENTORY_OWNERSHIP_ERRORS.V1_CONSUMING,
      requiresV2AwareProcedure: true,
    });
  }
  return Object.freeze({
    allowed: true,
    code: "CLEAR_ORDERS_SAFE",
    requiresV2AwareProcedure: false,
  });
}

export function assertClearOrdersV2Safe(state) {
  const result = evaluateClearOrdersSafety(state);
  if (!result.allowed) {
    throw ownershipError(
      result.code,
      "Manager clear-orders is not V2-safe; an owner-approved V2-aware procedure is required",
      { state }
    );
  }
  return result;
}

export const CUTOVER_OWNER_DECISIONS = Object.freeze([
  "Whether inventoryreservations is migrated to inventory_v2_allocations or retained as historical evidence.",
  "How existing V1 holds are drained before V2 allocation creation begins.",
  "How reservedStock is reconciled across both owner ledgers during cutover.",
  "Whether V1 and V2 reporting run in dual-read mode and for how long.",
  "The owner-approved backup/restore and rollback procedure.",
]);

export default INVENTORY_OWNERSHIP;
