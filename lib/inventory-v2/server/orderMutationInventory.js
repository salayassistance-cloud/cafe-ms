// BONO Inventory V2 — order mutation-path inventory and future version contract.
//
// Phase 2.0 is READ-ONLY with respect to order behaviour: this module documents
// every known order mutation path. It does not add `orderVersion` to the Order
// schema, does not change `lib/orderService.js`, and does not wire any V2 code
// into a live route.
//
// Verification status
// -------------------
// VERIFIED_FROM_SOURCE
//   The file/symbol was inspected directly and the documented write/delegation
//   is present in the current source.
// UNVERIFIED
//   A path exists but complete runtime coverage (dynamic imports, external
//   callers, operational scripts, direct collection access) was not proven.
// EXTERNAL_UNVERIFIED
//   The path is outside this repository or is an operational/manual tool whose
//   production usage cannot be established from source alone.
//
// The inventory is a STATIC SOURCE INVENTORY. It must never be presented as
// proof that no other writer exists at runtime.

import { assertServerOnly } from "./boundary.js";

assertServerOnly("Inventory V2 order mutation inventory");

export const ORDER_MUTATION_TYPES = Object.freeze({
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  BULK_DELETE: "BULK_DELETE",
  DELEGATED_WRITE: "DELEGATED_WRITE",
  DIRECT_COLLECTION_WRITE: "DIRECT_COLLECTION_WRITE",
  COUNTER_UPDATE: "COUNTER_UPDATE",
  MIGRATION: "MIGRATION",
  SEED: "SEED",
  TEST_MAINTENANCE: "TEST_MAINTENANCE",
  SCHEMA_INDEX_SYNC: "SCHEMA_INDEX_SYNC",
  READ_ONLY: "READ_ONLY",
  CLIENT_API_CALLER: "CLIENT_API_CALLER",
});

export const ORDER_MUTATION_VERIFICATION = Object.freeze({
  VERIFIED_FROM_SOURCE: "VERIFIED_FROM_SOURCE",
  UNVERIFIED: "UNVERIFIED",
  EXTERNAL_UNVERIFIED: "EXTERNAL_UNVERIFIED",
});

const T = ORDER_MUTATION_TYPES;
const V = ORDER_MUTATION_VERIFICATION;

export const ORDER_VERSION_CONTRACT = Object.freeze({
  field: "orderVersion",
  implementedInPhase2: false,
  type: "integer",
  control: "server-only",
  initialValue: 0,
  increment:
    "The same atomic write that mutates the order must also $inc orderVersion by 1.",
  conditionalUpdate:
    "Every concurrency-sensitive update filter must include the expected orderVersion.",
  binding:
    "Payment evidence and approval challenges must bind to the exact orderVersion they were issued against.",
  staleEvidence:
    "A version mismatch invalidates stale payment evidence, approval challenges, and replay claims.",
  updatedAtSubstitute:
    "FORBIDDEN. updatedAt is a timestamp and is not a monotonic concurrency token.",
  notes: Object.freeze([
    "Do not add orderVersion to the Order schema in Phase 2.0.",
    "Do not change lib/orderService.js behaviour in Phase 2.0.",
    "The future increment must be part of the same atomic write, not a second write.",
  ]),
});

export const CANCEL_ORDER_ITEM_UPDATED_AT_ANALYSIS = Object.freeze({
  file: "lib/orderService.js",
  symbol: "cancelOrderItem",
  currentToken: "updatedAt",
  currentBehaviour: Object.freeze([
    "The first atomic update cancels the matched line via arrayFilters and stamps updatedAt.",
    "A guarded second update derives station/overall status only when updatedAt still equals the first write's value.",
    "A miss means a concurrent writer owns the newer state; the second write is skipped.",
  ]),
  risks: Object.freeze([
    "updatedAt is not monotonic and has finite timestamp resolution.",
    "Two writers can theoretically produce the same timestamp value.",
    "The token is not bound to payment evidence, approval challenges, or inventory ownership.",
    "The second write is a separate operation; there is no single orderVersion increment covering both.",
  ]),
  phase2Decision:
    "DOCUMENT ONLY. Do not replace updatedAt with orderVersion in Phase 2.0.",
  futureContract: Object.freeze([
    "The line-cancel write and the derived-status write must share one orderVersion increment.",
    "If two writes remain, both must carry the expected orderVersion and the second must be conditional on the first write's version.",
    "Payment evidence and approval challenges must reject a version mismatch.",
  ]),
});

export const ORDER_MUTATION_INVENTORY = Object.freeze([
  // ---------------------------------------------------------------------------
  // lib/orderService.js — authoritative order service
  // ---------------------------------------------------------------------------
  {
    file: "lib/orderService.js",
    symbol: "createOrder",
    mutationType: T.CREATE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: true,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes:
      "Creates the Order document and immediately calls ensureOrderInventoryReservation. Future orderVersion must be initialised in the same document write.",
  },
  {
    file: "lib/orderService.js",
    symbol: "updateOrderStatus",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: false,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes:
      "Single aggregation-pipeline update. PREPARING consumes inventory before the status write; the filter already binds the expected station state.",
  },
  {
    file: "lib/orderService.js",
    symbol: "serveOrder",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "READY -> SERVED aggregation-pipeline update.",
  },
  {
    file: "lib/orderService.js",
    symbol: "payOrder",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: true,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes:
      "Payment settlement then applyPaidInventory. Inventory side effects occur after the order write and are best-effort in V1.",
  },
  {
    file: "lib/orderService.js",
    symbol: "archiveOrder",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: false,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "Sets ARCHIVED via updateOrderFields and releases/reconciles inventory.",
  },
  {
    file: "lib/orderService.js",
    symbol: "cancelOrderByWaiter",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: false,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "PENDING own order -> CANCELLED, then releaseOrderInventory.",
  },
  {
    file: "lib/orderService.js",
    symbol: "cancelOrder",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: false,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "Manager whole-order cancellation via updateOrderFields.",
  },
  {
    file: "lib/orderService.js",
    symbol: "cancelOrderItem",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: false,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes:
      "Two-step line cancel. The guarded derived-status write currently uses updatedAt as the optimistic token; see CANCEL_ORDER_ITEM_UPDATED_AT_ANALYSIS.",
  },
  {
    file: "lib/orderService.js",
    symbol: "editOrderItems",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: false,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes:
      "PENDING-only atomic items/total write guarded by status (and waiter ownership), then reconcileOrderInventory.",
  },
  {
    file: "lib/orderService.js",
    symbol: "submitPaymentForVerification",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: false,
    affectsPayment: true,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "SERVED -> PAYMENT_PENDING with payment snapshot.",
  },
  {
    file: "lib/orderService.js",
    symbol: "confirmPayment",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: true,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "PAYMENT_PENDING -> PAID then applyPaidInventory.",
  },
  {
    file: "lib/orderService.js",
    symbol: "rejectPayment",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: false,
    affectsPayment: true,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "PAYMENT_PENDING -> SERVED with rejection audit fields.",
  },
  {
    file: "lib/orderService.js",
    symbol: "updatePayment",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: false,
    affectsPayment: true,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes:
      "Calls updateOrderFields once, and a second time when stamping paid/completed timestamps.",
  },
  {
    file: "lib/orderService.js",
    symbol: "applyPaidInventory",
    mutationType: T.UPDATE,
    writesOrder: false,
    affectsInventory: true,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes:
      "Internal inventory consumption/release helper. It does not mutate the Order document.",
  },
  {
    file: "lib/orderService.js",
    symbol: "updateOrderFields",
    mutationType: T.UPDATE,
    writesOrder: true,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes:
      "Internal $set helper. It does not increment a version itself; every caller must include the future orderVersion increment in the same write.",
  },
  {
    file: "lib/orderService.js",
    symbol: "genOrderNumber",
    mutationType: T.COUNTER_UPDATE,
    writesOrder: false,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "Direct counters collection update for ORD- sequence generation.",
  },

  // ---------------------------------------------------------------------------
  // API routes — delegated writes
  // ---------------------------------------------------------------------------
  {
    file: "app/api/orders/route.js",
    symbol: "POST",
    mutationType: T.DELEGATED_WRITE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: true,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    delegatesTo: Object.freeze(["lib/orderService.js#createOrder"]),
    notes: "Delegates order creation; route itself does not write the Order collection.",
  },
  {
    file: "app/api/orders/[id]/route.js",
    symbol: "PATCH",
    mutationType: T.DELEGATED_WRITE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: true,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    delegatesTo: Object.freeze([
      "lib/orderService.js#cancelOrderItem",
      "lib/orderService.js#editOrderItems",
      "lib/orderService.js#cancelOrderByWaiter",
      "lib/orderService.js#rejectPayment",
      "lib/orderService.js#cancelOrder",
      "lib/orderService.js#archiveOrder",
      "lib/orderService.js#serveOrder",
      "lib/orderService.js#submitPaymentForVerification",
      "lib/orderService.js#confirmPayment",
      "lib/orderService.js#payOrder",
      "lib/orderService.js#updateOrderStatus",
      "lib/orderService.js#updatePayment",
    ]),
    notes: "Multi-action route; every branch delegates to orderService.",
  },
  {
    file: "app/api/orders/[id]/route.js",
    symbol: "DELETE",
    mutationType: T.DELEGATED_WRITE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: false,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    delegatesTo: Object.freeze(["lib/orderService.js#archiveOrder"]),
    notes: "Soft delete/archive alias.",
  },
  {
    file: "app/api/orders/[id]/status/route.js",
    symbol: "PATCH",
    mutationType: T.DELEGATED_WRITE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: true,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: true,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    delegatesTo: Object.freeze([
      "lib/orderService.js#updateOrderStatus",
      "lib/orderService.js#serveOrder",
      "lib/orderService.js#payOrder",
      "lib/orderService.js#confirmPayment",
    ]),
    notes: "Status-focused route; delegates all writes to orderService.",
  },
  {
    file: "app/api/manager/settings/clear-orders/route.js",
    symbol: "POST",
    mutationType: T.BULK_DELETE,
    writesOrder: true,
    affectsInventory: true,
    affectsPayment: false,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes:
      "CRITICAL RISK: Order.deleteMany({}) plus a global InventoryItem reservedStock reset. A V2 hold would be erased. Phase 2.0 does not change this route; a future V2-aware guard/procedure is mandatory.",
  },
  {
    file: "app/api/cashier/report/route.js",
    symbol: "GET",
    mutationType: T.READ_ONLY,
    writesOrder: false,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "Reporting read only.",
  },
  {
    file: "app/api/station/report/route.js",
    symbol: "GET",
    mutationType: T.READ_ONLY,
    writesOrder: false,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "Reporting read only.",
  },
  {
    file: "app/api/manager/analytics/route.js",
    symbol: "GET",
    mutationType: T.READ_ONLY,
    writesOrder: false,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "Reporting read only.",
  },
  {
    file: "app/api/manager/waiter-analytics/route.js",
    symbol: "GET",
    mutationType: T.READ_ONLY,
    writesOrder: false,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes: "Reporting read only.",
  },

  // ---------------------------------------------------------------------------
  // Scripts and maintenance utilities
  // ---------------------------------------------------------------------------
  {
    file: "scripts/clean-order-history.js",
    symbol: "main",
    mutationType: T.BULK_DELETE,
    writesOrder: true,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.EXTERNAL_UNVERIFIED,
    notes:
      "Operational script. Deletes orders and resets counters directly. Production usage is not proven from source.",
  },
  {
    file: "scripts/migrate-phase3-canonical.js",
    symbol: "migrate",
    mutationType: T.MIGRATION,
    writesOrder: true,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: true,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.EXTERNAL_UNVERIFIED,
    notes:
      "Direct orders collection updateOne migration. Future live mutations must carry orderVersion.",
  },
  {
    file: "scripts/seed-orders.mjs",
    symbol: "main",
    mutationType: T.SEED,
    writesOrder: true,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: true,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.EXTERNAL_UNVERIFIED,
    notes:
      "Seed/test data. Deletes namespaced orders, saves documents, and updates the counter directly.",
  },
  {
    file: "scripts/test-phase65-security.js",
    symbol: "main",
    mutationType: T.TEST_MAINTENANCE,
    writesOrder: true,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.EXTERNAL_UNVERIFIED,
    notes: "Test maintenance script with direct save/delete on TEST-W orders.",
  },
  {
    file: "scripts/sync-indexes.js",
    symbol: "main",
    mutationType: T.SCHEMA_INDEX_SYNC,
    writesOrder: false,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.EXTERNAL_UNVERIFIED,
    notes:
      "Schema index sync only. It does not write order documents and must never be extended to V2 collections.",
  },
  {
    file: "scripts/verify-analytics.mjs",
    symbol: "main",
    mutationType: T.READ_ONLY,
    writesOrder: false,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.EXTERNAL_UNVERIFIED,
    notes: "Analytics verification script; reviewed as read-only.",
  },

  // ---------------------------------------------------------------------------
  // Client callers (no direct database access)
  // ---------------------------------------------------------------------------
  {
    file: "app/components/KitchenDisplay.js",
    symbol: "updateOrder",
    mutationType: T.CLIENT_API_CALLER,
    writesOrder: false,
    affectsInventory: false,
    affectsPayment: false,
    affectsKdsEvidence: false,
    mustIncrementOrderVersion: false,
    requiresOptimisticConcurrency: false,
    verificationStatus: V.VERIFIED_FROM_SOURCE,
    notes:
      "Client calls the order API; it must never be treated as an authoritative writer.",
  },
]);

export const UNVERIFIED_WRITER_RISKS = Object.freeze([
  "External integrations, ad-hoc operational scripts, and direct mongosh writes are not discoverable from this repository.",
  "Dynamic imports and indirect service delegation may hide additional order writers.",
  "The inventory proves static source presence, not complete runtime coverage.",
  "Manager clear-orders remains a destructive global reset until a V2-aware guard is implemented.",
  "V1 InventoryReservation and future V2 allocations must never both own the same order.",
]);

const REQUIRED_MUTATION_PATHS = Object.freeze([
  "lib/orderService.js#createOrder",
  "lib/orderService.js#updateOrderStatus",
  "lib/orderService.js#serveOrder",
  "lib/orderService.js#payOrder",
  "lib/orderService.js#cancelOrder",
  "lib/orderService.js#cancelOrderItem",
  "lib/orderService.js#editOrderItems",
  "app/api/manager/settings/clear-orders/route.js#POST",
]);

const REQUIRED_FIELDS = Object.freeze([
  "file",
  "symbol",
  "mutationType",
  "writesOrder",
  "affectsInventory",
  "affectsPayment",
  "affectsKdsEvidence",
  "mustIncrementOrderVersion",
  "requiresOptimisticConcurrency",
  "verificationStatus",
  "notes",
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateOrderMutationInventory(
  inventory = ORDER_MUTATION_INVENTORY
) {
  const issues = [];

  if (!Array.isArray(inventory) || inventory.length === 0) {
    return {
      ok: false,
      issues: [
        { type: "INVALID_INVENTORY", detail: "Inventory must be a non-empty array" },
      ],
    };
  }

  const seen = new Set();
  for (const [position, entry] of inventory.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ type: "INVALID_ENTRY", position });
      continue;
    }
    for (const field of REQUIRED_FIELDS) {
      if (!(field in entry)) {
        issues.push({ type: "MISSING_FIELD", position, field });
      }
    }
    for (const field of ["file", "symbol", "notes"]) {
      if (!isNonEmptyString(entry[field])) {
        issues.push({ type: "INVALID_STRING_FIELD", position, field });
      }
    }
    for (const field of [
      "writesOrder",
      "affectsInventory",
      "affectsPayment",
      "affectsKdsEvidence",
      "mustIncrementOrderVersion",
      "requiresOptimisticConcurrency",
    ]) {
      if (typeof entry[field] !== "boolean") {
        issues.push({ type: "INVALID_BOOLEAN_FIELD", position, field });
      }
    }
    if (!Object.values(ORDER_MUTATION_TYPES).includes(entry.mutationType)) {
      issues.push({
        type: "INVALID_MUTATION_TYPE",
        position,
        mutationType: entry.mutationType,
      });
    }
    if (!Object.values(ORDER_MUTATION_VERIFICATION).includes(entry.verificationStatus)) {
      issues.push({
        type: "INVALID_VERIFICATION_STATUS",
        position,
        verificationStatus: entry.verificationStatus,
      });
    }
    const identity = `${entry.file}#${entry.symbol}`;
    if (seen.has(identity)) {
      issues.push({ type: "DUPLICATE_PATH", position, identity });
    }
    seen.add(identity);
  }

  for (const required of REQUIRED_MUTATION_PATHS) {
    if (!seen.has(required)) {
      issues.push({ type: "MISSING_REQUIRED_PATH", identity: required });
    }
  }

  const clearOrders = inventory.find(
    (entry) => entry.file === "app/api/manager/settings/clear-orders/route.js"
  );
  if (!clearOrders) {
    issues.push({
      type: "MISSING_CLEAR_ORDERS_RISK",
      detail: "clear-orders must be documented",
    });
  } else {
    const notes = String(clearOrders.notes || "").toLowerCase();
    if (!notes.includes("reservedstock") || !notes.includes("v2")) {
      issues.push({
        type: "INCOMPLETE_CLEAR_ORDERS_RISK",
        detail: "clear-orders notes must mention reservedStock and V2",
      });
    }
  }

  const cancelItem = inventory.find(
    (entry) =>
      entry.file === "lib/orderService.js" && entry.symbol === "cancelOrderItem"
  );
  if (!cancelItem) {
    issues.push({
      type: "MISSING_CANCEL_ORDER_ITEM",
      detail: "cancelOrderItem must be documented",
    });
  } else {
    if (cancelItem.requiresOptimisticConcurrency !== true) {
      issues.push({
        type: "CANCEL_ORDER_ITEM_OCC_MISSING",
        detail: "cancelOrderItem must require optimistic concurrency",
      });
    }
    if (!String(cancelItem.notes || "").includes("updatedAt")) {
      issues.push({
        type: "CANCEL_ORDER_ITEM_TOKEN_UNDOCUMENTED",
        detail: "cancelOrderItem notes must document the updatedAt token",
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

export class InventoryV2OrderInventoryError extends Error {
  constructor(issues) {
    super("Order mutation inventory is invalid");
    this.name = "InventoryV2OrderInventoryError";
    this.code = "INVENTORY_V2_ORDER_INVENTORY_INVALID";
    this.issues = Object.freeze([...(issues ?? [])]);
  }
}

export function assertOrderMutationInventory(inventory = ORDER_MUTATION_INVENTORY) {
  const result = validateOrderMutationInventory(inventory);
  if (!result.ok) throw new InventoryV2OrderInventoryError(result.issues);
  return true;
}

export function getOrderMutationInventory() {
  return ORDER_MUTATION_INVENTORY;
}

export function findOrderMutationPath(file, symbol) {
  return (
    ORDER_MUTATION_INVENTORY.find(
      (entry) => entry.file === file && entry.symbol === symbol
    ) ?? null
  );
}

export default ORDER_MUTATION_INVENTORY;
