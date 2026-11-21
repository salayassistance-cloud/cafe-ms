// Phase 1 — pre-preparation inventory reservation / Manager override.
//
// DB-free proofs only: no MongoDB connection is opened and no production data
// is touched. The suite combines:
//   * executable unit tests for the pure allocation/fingerprint rules,
//   * model/index assertions,
//   * source-contract assertions for the order lifecycle hooks and APIs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  availableOf,
  planCoverage,
  buildRequirementFingerprint,
  buildShortageFingerprint,
  round3,
} from "../lib/inventoryReservationRules.js";
import {
  InventoryReservationSchema,
  RESERVATION_STATUS,
} from "../lib/models/InventoryReservation.js";
import { InventoryItemSchema } from "../lib/models/InventoryItem.js";
import { StockMovementSchema } from "../lib/models/StockMovement.js";
import { can, ROLES } from "../lib/policy.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const exists = (p) => existsSync(join(root, p));

const A = "64b000000000000000000001";
const B = "64b000000000000000000002";

function inventory(currentStock, reservedStock = 0) {
  return { currentStock, reservedStock };
}

function reserveSnapshot(requirements, stock) {
  const items = requirements.map((req) => {
    const inv = stock[req.inventoryItemId];
    const available = availableOf(inv);
    const plan = planCoverage(req.requiredQuantity, 0, available);
    // Apply the hold exactly like the service transaction does.
    inv.reservedStock = round3((inv.reservedStock || 0) + plan.reservedQuantity);
    return {
      inventoryItemId: req.inventoryItemId,
      unit: req.unit,
      requiredQuantity: req.requiredQuantity,
      reservedQuantity: plan.reservedQuantity,
      shortageQuantity: plan.shortageQuantity,
      availableAtDecision: round3(available),
    };
  });
  return items;
}

function previewApprovalSnapshot(requirements, stock, heldItems) {
  return requirements.map((req) => {
    const held = heldItems.find((it) => it.inventoryItemId === req.inventoryItemId);
    const inv = stock[req.inventoryItemId];
    const available = availableOf(inv);
    const heldQty = held?.reservedQuantity || 0;
    const plan = planCoverage(req.requiredQuantity, heldQty, available);
    return {
      inventoryItemId: req.inventoryItemId,
      unit: req.unit,
      requiredQuantity: req.requiredQuantity,
      reservedQuantity: plan.reservedQuantity,
      shortageQuantity: plan.shortageQuantity,
      availableAtDecision: round3(heldQty + available),
    };
  });
}

describe("pure reservation rules", () => {
  test("available = currentStock - reservedStock, never negative", () => {
    assert.equal(availableOf(inventory(10, 4)), 6);
    assert.equal(availableOf(inventory(2, 5)), 0);
    assert.equal(availableOf({}), 0);
    assert.equal(availableOf({ currentStock: 3 }), 3);
  });

  test("sufficient stock reserves the full requirement", () => {
    const plan = planCoverage(5, 0, 8);
    assert.equal(plan.reservedQuantity, 5);
    assert.equal(plan.shortageQuantity, 0);
  });

  test("insufficient stock holds only what physically exists", () => {
    const plan = planCoverage(5, 0, 2);
    assert.equal(plan.reservedQuantity, 2);
    assert.equal(plan.shortageQuantity, 3);
  });

  test("existing hold counts toward coverage without over-reserving", () => {
    const plan = planCoverage(5, 3, 4);
    assert.equal(plan.reservedQuantity, 5);
    assert.equal(plan.shortageQuantity, 0);
  });

  test("required quantity is rounded to 3 decimals", () => {
    const plan = planCoverage(1.23456, 0, 0);
    assert.equal(plan.requiredQuantity, 1.235);
    assert.equal(plan.shortageQuantity, 1.235);
  });
});

describe("requirement and shortage fingerprints", () => {
  test("requirement fingerprint is order/unit/qty sensitive and order independent", () => {
    const items = [
      { inventoryItemId: A, unit: "kg", requiredQuantity: 2 },
      { inventoryItemId: B, unit: "g", requiredQuantity: 50 },
    ];
    const fp1 = buildRequirementFingerprint("order-1", items);
    const fp2 = buildRequirementFingerprint("order-1", [...items].reverse());
    assert.equal(fp1, fp2, "requirement order must not change the fingerprint");
    assert.notEqual(fp1, buildRequirementFingerprint("order-1", [{ ...items[0], requiredQuantity: 3 }]));
    assert.notEqual(fp1, buildRequirementFingerprint("order-1", [{ ...items[0], unit: "g" }, items[1]]));
    assert.notEqual(fp1, buildRequirementFingerprint("order-2", items));
  });

  test("shortage fingerprint changes when available stock changes", () => {
    const reqFp = buildRequirementFingerprint("order-1", [
      { inventoryItemId: A, unit: "kg", requiredQuantity: 5 },
    ]);
    const base = [
      {
        inventoryItemId: A,
        unit: "kg",
        requiredQuantity: 5,
        availableAtDecision: 2,
        shortageQuantity: 3,
      },
    ];
    const changed = [{ ...base[0], availableAtDecision: 1, shortageQuantity: 4 }];
    assert.notEqual(
      buildShortageFingerprint(reqFp, base),
      buildShortageFingerprint(reqFp, changed)
    );
  });

  test("initial snapshot and approval preview produce the SAME fingerprint", () => {
    const stock = { [A]: inventory(2), [B]: inventory(10) };
    const requirements = [
      { inventoryItemId: A, unit: "kg", requiredQuantity: 5 },
      { inventoryItemId: B, unit: "g", requiredQuantity: 4 },
    ];
    const snapshot = reserveSnapshot(requirements, stock);
    const requirementFp = buildRequirementFingerprint("order-1", requirements);
    const snapshotFp = buildShortageFingerprint(requirementFp, snapshot);

    // Simulate the manager opening the approval screen after the holds landed.
    const preview = previewApprovalSnapshot(requirements, stock, snapshot);
    const previewFp = buildShortageFingerprint(requirementFp, preview);

    assert.equal(snapshotFp, previewFp);
    // The fully-covered item is not falsely reported as a full shortage.
    assert.equal(preview.find((it) => it.inventoryItemId === B).shortageQuantity, 0);
    assert.equal(preview.find((it) => it.inventoryItemId === A).shortageQuantity, 3);
  });

  test("changed stock invalidates the displayed shortage fingerprint", () => {
    const stock = { [A]: inventory(2) };
    const requirements = [{ inventoryItemId: A, unit: "kg", requiredQuantity: 5 }];
    const snapshot = reserveSnapshot(requirements, stock);
    const requirementFp = buildRequirementFingerprint("order-1", requirements);
    const displayed = buildShortageFingerprint(requirementFp, snapshot);

    stock[A].currentStock = 4; // restock after display changes the shortage
    const preview = previewApprovalSnapshot(requirements, stock, snapshot);
    const current = buildShortageFingerprint(requirementFp, preview);
    assert.notEqual(displayed, current);
  });
});

describe("models and indexes", () => {
  test("InventoryReservation is one document per order with the full lifecycle", () => {
    assert.equal(exists("lib/models/InventoryReservation.js"), true);
    assert.equal(InventoryReservationSchema.path("orderId").options.unique, true);
    for (const status of [
      "NO_INVENTORY",
      "RESERVED",
      "INSUFFICIENT_STOCK",
      "CONSUMING",
      "CONSUMED",
      "RELEASED",
    ]) {
      assert.ok(RESERVATION_STATUS.includes(status), `missing primary status ${status}`);
    }
    // Historical reservations still hydrate; these are never written by new code.
    for (const legacy of ["APPROVAL_REQUIRED", "APPROVED"]) {
      assert.ok(RESERVATION_STATUS.includes(legacy), `missing legacy read status ${legacy}`);
    }
    // Historical approval evidence remains readable but is no longer produced.
    assert.ok(InventoryReservationSchema.path("approval.reason"));
    assert.ok(InventoryReservationSchema.path("approval.managerId"));
    assert.ok(InventoryReservationSchema.path("approval.shortageFingerprint"));
  });

  test("InventoryItem exposes a non-negative reservedStock hold", () => {
    const path = InventoryItemSchema.path("reservedStock");
    assert.ok(path, "reservedStock must exist");
    assert.equal(path.options.min, 0);
    assert.equal(path.options.default, 0);
  });

  test("SaleDeduction uniqueness is per (order, reason, item)", () => {
    const index = StockMovementSchema.indexes().find(
      (entry) => entry[0]?.refOrderId === 1 && entry[0]?.reason === 1
    );
    assert.ok(index, "sale deduction index missing");
    assert.equal(index[0].item, 1);
    assert.equal(index[1].unique, true);
  });

  test("no Manager shortage approval permission or writer remains", () => {
    for (const role of Object.values(ROLES)) {
      assert.equal(can(role, "inventory:approve"), false, `${role} must not approve shortages`);
    }
    const service = src("lib/inventoryReservationService.js");
    assert.equal(service.includes("approveInventoryShortage"), false);
    assert.equal(service.includes("getInventoryApprovalQueue"), false);
    assert.equal(exists("app/api/orders/[id]/inventory-approval/route.js"), false);
    assert.equal(exists("app/api/manager/inventory-approvals/route.js"), false);
  });
});

describe("order lifecycle integration contracts", () => {
  const orderService = src("lib/orderService.js");
  const reservationService = src("lib/inventoryReservationService.js");

  test("order creation creates the pre-preparation reservation without blocking intake", () => {
    const create = orderService.slice(
      orderService.indexOf("export async function createOrder"),
      orderService.indexOf("function buildOrderQuery")
    );
    assert.ok(create.includes("ensureOrderInventoryReservation(conn, doc)"));
    assert.ok(create.includes("runInventoryHook"), "reservation failure must not roll back the order");
  });

  test("PREPARING is gated before the atomic station write", () => {
    const update = orderService.slice(
      orderService.indexOf("export async function updateOrderStatus"),
      orderService.indexOf("export async function serveOrder")
    );
    const gate = update.indexOf("assertOrderInventoryReady(conn, pre)");
    const write = update.indexOf("Order.findOneAndUpdate(filter, pipeline");
    assert.ok(gate > 0, "PREPARING gate missing");
    assert.ok(write > gate, "gate must run before the station write");
    assert.ok(
      update.includes('if (status === "PREPARING")'),
      "only preparation start is gated (READY is not re-gated)"
    );
  });

  test("payment consumes the reservation exactly once instead of the legacy executor", () => {
    assert.ok(orderService.includes("await applyPaidInventory(conn, doc, actorId)"));
    assert.ok(orderService.includes('consumeOrderInventory(conn, doc, { actorId, trigger: "PAYMENT" })'));
    assert.equal(
      orderService.includes("executeInventoryDeduction"),
      false,
      "legacy unconditional deduction must not run on the payment path"
    );
    assert.ok(reservationService.includes('status: { $in: ["RESERVED", "APPROVED", "NO_INVENTORY"] }'));
    assert.ok(reservationService.includes('{ $set: { status: "CONSUMING" } }'));
    assert.ok(reservationService.includes("currentStock: { $gte: consumeQty }"));
    assert.ok(reservationService.includes("reservedStock: { $gte: consumeQty }"));
  });

  test("cancellation/archive release holds before preparation and void after", () => {
    assert.ok(orderService.includes('releaseOrderInventory(conn, archived, { reason: "ARCHIVED", recordVoid: false })'));
    assert.ok(orderService.includes('releaseOrderInventory(conn, cancelled, {'));
    assert.ok(orderService.includes('actorId: actorOid,'));
    assert.ok(orderService.includes('source: "ORDER",'));
    assert.ok(orderService.includes('recordPostPreparationVoid(conn, doc, {'));
    assert.ok(orderService.includes("reconcileOrderInventory(conn, docAfter)"));
    assert.ok(orderService.includes('doc.status === "CANCELLED"'));
  });

  test("release and consumption claim their state atomically and idempotently", () => {
    assert.ok(reservationService.includes('status: { $nin: ["RELEASED", "CONSUMED"] }'));
    assert.ok(reservationService.includes('status: "CONSUMING"'));
    assert.ok(reservationService.includes('status: "CONSUMED"'));
    assert.ok(reservationService.includes("Legacy sale deduction already recorded"));
  });

  test("reservation service only decrements stock conditionally", () => {
    assert.ok(reservationService.includes("currentStock: { $gte: consumeQty }"));
    assert.ok(reservationService.includes("reservedStock: { $gte: consumeQty }"));
    assert.ok(reservationService.includes("{ $inc: { currentStock: -consumeQty, reservedStock: -consumeQty } }"));
    assert.equal(
      reservationService.includes("$inc: { currentStock: -qty }"),
      false,
      "unconditional decrement must not exist"
    );
  });

  test("clear-orders returns holds it deletes and preserves consumed evidence", () => {
    const clear = src("app/api/manager/settings/clear-orders/route.js");
    assert.ok(clear.includes('Reservation.deleteMany({ status: { $nin: ["CONSUMED", "CONSUMING"] } })'));
    assert.ok(clear.includes("$set: { reservedStock: 0 }"));
    assert.ok(clear.includes('"CONSUMED", "CONSUMING"'), "consumed reservations must survive a reset");
  });

  test("waste can only consume unreserved stock", () => {
    const waste = src("lib/inventoryWasteService.js");
    assert.ok(waste.includes('$ifNull: ["$reservedStock", 0]'));
    assert.ok(waste.includes("Insufficient available stock"));
  });
});

describe("Stock Policy A shortage blocking contracts", () => {
  const reservationService = src("lib/inventoryReservationService.js");

  test("a shortage is a blocking state, never a Manager approval request", () => {
    assert.ok(
      reservationService.includes('const status = fullyReserved ? "RESERVED" : "INSUFFICIENT_STOCK";'),
      "reservation decision must write INSUFFICIENT_STOCK"
    );
    assert.ok(reservationService.includes('nextStatus = "INSUFFICIENT_STOCK"'));
    assert.equal(reservationService.includes("MANAGER_APPROVAL_REQUIRED"), false);
    assert.equal(reservationService.includes("APPROVAL_STALE"), false);
  });

  test("preparation and payment both reject an insufficient-stock reservation", () => {
    const prepGate = reservationService.indexOf("export async function assertOrderInventoryReady");
    const payGate = reservationService.indexOf("export async function assertOrderInventoryPayable");
    assert.ok(prepGate > 0 && payGate > prepGate);
    const prep = reservationService.slice(prepGate, payGate);
    assert.ok(prep.includes('if (reservation.status === "INSUFFICIENT_STOCK")'));
    assert.ok(prep.includes('"INSUFFICIENT_STOCK"'));
    assert.ok(prep.includes('if (reservation.status === "APPROVAL_REQUIRED")'), "legacy state blocks too");
    const pay = reservationService.slice(payGate);
    assert.ok(pay.includes("assertOrderInventoryReady(conn, order)"));
    assert.ok(pay.includes("Payment is blocked until stock is available"));
  });

  test("legacy APPROVAL_REQUIRED/APPROVED are read-only and cannot be re-adopted", () => {
    assert.ok(reservationService.includes("Legacy pre-policy shortage state"));
    assert.ok(reservationService.includes("approval: null"));
    assert.ok(reservationService.includes('["INSUFFICIENT_STOCK", "APPROVAL_REQUIRED"]'));
  });

  test("removed approval routes stay absent", () => {
    assert.equal(exists("app/api/orders/[id]/inventory-approval/route.js"), false);
    assert.equal(exists("app/api/manager/inventory-approvals/route.js"), false);
  });
});
