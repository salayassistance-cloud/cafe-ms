// Phase 1.1 — consumption timing, post-preparation cancellation, and waste
// accounting. DB-free proofs only: no MongoDB connection is opened.
//
// The executable half mirrors the reservation service's state machine with the
// same pure rules (`consumptionPlan`, `releasePlan`, `hasConsumedStock`) so the
// lifecycle is proven without a database. The contract half asserts that the
// real service/order/API code wires those rules at the right lifecycle points.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  availableOf,
  planCoverage,
  round3,
  hasConsumedStock,
  releasePlan,
  consumptionPlan,
} from "../lib/inventoryReservationRules.js";
import {
  InventoryReservationSchema,
} from "../lib/models/InventoryReservation.js";
import { StockMovementSchema } from "../lib/models/StockMovement.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const ITEM_A = "64b00000000000000000000a";
const ITEM_B = "64b00000000000000000000b";
const STAFF = "64b0000000000000000000f1";
const LINE_1 = "64b0000000000000000000a1";
const LINE_2 = "64b0000000000000000000a2";

function stockOf(entries) {
  return Object.fromEntries(
    Object.entries(entries).map(([id, values]) => [
      id,
      { currentStock: values.currentStock, reservedStock: values.reservedStock || 0 },
    ])
  );
}

function requirement(inventoryItemId, unit, requiredQuantity, stock) {
  const inv = stock[inventoryItemId];
  const plan = planCoverage(requiredQuantity, 0, availableOf(inv));
  inv.reservedStock = round3((inv.reservedStock || 0) + plan.reservedQuantity);
  return {
    inventoryItemId,
    unit,
    requiredQuantity: plan.requiredQuantity,
    reservedQuantity: plan.reservedQuantity,
    shortageQuantity: plan.shortageQuantity,
    availableAtDecision: round3(availableOf(inv) + plan.reservedQuantity),
    consumedQuantity: 0,
  };
}

function reservation(orderId, items, extra = {}) {
  return {
    orderId,
    status: "RESERVED",
    items,
    approval: null,
    consumedAt: null,
    consumedBy: null,
    consumedTrigger: null,
    releasedAt: null,
    releaseReason: null,
    voidedAt: null,
    voidReason: null,
    voidedBy: null,
    voids: [],
    ...extra,
  };
}

// Mirrors consumeOrderInventory's claim + conditional decrement + one movement
// per ingredient.
function consume(res, stock, { trigger = "PREPARING", orderNumber = "ORD-1", movements = [] } = {}) {
  const plan = consumptionPlan(res.status);
  if (plan !== "CONSUME") return { consumed: false, plan };

  res.status = "CONSUMING";
  let total = 0;
  for (const it of res.items) {
    const inv = stock[it.inventoryItemId];
    const reserved = round3(it.reservedQuantity);
    const required = Math.max(0, round3(it.requiredQuantity) - round3(it.consumedQuantity));
    const physical = Math.max(0, Number(inv?.currentStock) || 0);
    const held = Math.max(0, Number(inv?.reservedStock) || 0);
    const consumeQty = Math.max(0, Math.min(reserved, required, physical, held));
    const releaseQty = Math.max(0, round3(reserved - consumeQty));

    if (consumeQty > 0) {
      inv.currentStock = round3(physical - consumeQty);
      inv.reservedStock = round3(Math.max(0, held - consumeQty));
      movements.push({
        item: it.inventoryItemId,
        type: "OUT",
        reason: "SaleDeduction",
        quantity: consumeQty,
        totalCost: round3(consumeQty * 10),
        refOrderId: res.orderId,
        notes: `Sale deduction for order ${orderNumber}`,
      });
      total = round3(total + consumeQty);
    }
    if (releaseQty > 0) {
      inv.reservedStock = round3(Math.max(0, (Number(inv?.reservedStock) || 0) - releaseQty));
    }
    it.consumedQuantity = round3(it.consumedQuantity + consumeQty);
    it.reservedQuantity = 0;
  }

  res.status = "CONSUMED";
  res.consumedAt = new Date("2026-11-04T10:00:00.000Z");
  res.consumedTrigger = trigger;
  return { consumed: true, total };
}

// Mirrors releaseOrderInventory / recordPostPreparationVoid.
function cancel(res, stock, movements = [], opts = {}) {
  const source = String(opts.source || "ORDER").toUpperCase();
  const plan = releasePlan(res, { source, recordVoid: opts.recordVoid !== false });
  const now = new Date("2026-11-04T11:00:00.000Z");
  const reason = opts.reason || "CANCELLED";

  if (plan.action === "RELEASE_HOLDS") {
    if (res.status === "RELEASED") return { action: "NOOP_ALREADY_RELEASED" };
    for (const it of res.items) {
      const qty = round3(it.reservedQuantity);
      if (qty > 0) {
        const inv = stock[it.inventoryItemId];
        inv.reservedStock = round3(Math.max(0, (Number(inv.reservedStock) || 0) - qty));
      }
      it.reservedQuantity = 0;
    }
    res.status = "RELEASED";
    res.releasedAt = now;
    res.releaseReason = reason;
    return { action: "RELEASED" };
  }

  if (!plan.recordVoid) return { action: "PRESERVED_CONSUMED" };

  if (source === "LINE") {
    if (res.voids.some((v) => v.source === "LINE" && v.lineId === opts.lineId)) {
      return { action: "NOOP_DUPLICATE_VOID" };
    }
  } else if (res.voids.some((v) => v.source === "ORDER")) {
    return { action: "NOOP_DUPLICATE_VOID" };
  }

  res.voidedAt = res.voidedAt || now;
  res.voidReason = reason;
  res.voidedBy = opts.actorId || null;
  res.voids.push({
    at: now,
    by: opts.actorId || null,
    reason,
    phase: plan.phase,
    source,
    lineId: opts.lineId || null,
    station: opts.station || null,
    items:
      source === "ORDER"
        ? res.items
            .map((it) => ({
              inventoryItemId: it.inventoryItemId,
              unit: it.unit,
              quantity: round3(it.consumedQuantity),
            }))
            .filter((it) => it.quantity > 0)
        : [],
  });

  if (plan.reclassifyMovements) {
    for (const m of movements) {
      if (m.reason === "SaleDeduction") {
        m.reason = "Waste";
        m.voidedAt = now;
        m.voidReason = reason;
        m.voidedBy = opts.actorId || null;
      }
    }
  }

  return { action: "VOIDED" };
}

describe("Phase 1.1 lifecycle — executable state machine", () => {
  test("cancellation before preparation releases the hold and keeps physical stock", () => {
    const stock = stockOf({ [ITEM_A]: { currentStock: 10 } });
    const item = requirement(ITEM_A, "kg", 4, stock);
    const res = reservation("order-before", [item]);
    const movements = [];

    assert.equal(availableOf(stock[ITEM_A]), 6);
    assert.equal(hasConsumedStock(res), false);

    const result = cancel(res, stock, movements, { reason: "WAITER_CANCELLED", actorId: STAFF });
    assert.equal(result.action, "RELEASED");
    assert.equal(stock[ITEM_A].currentStock, 10);
    assert.equal(stock[ITEM_A].reservedStock, 0);
    assert.equal(res.status, "RELEASED");
    assert.equal(res.voids.length, 0);
    assert.equal(movements.length, 0);
  });

  test("cancellation after preparation never restores consumed stock and records waste", () => {
    const stock = stockOf({ [ITEM_A]: { currentStock: 10 } });
    const item = requirement(ITEM_A, "kg", 4, stock);
    const res = reservation("order-after", [item]);
    const movements = [];

    assert.equal(consume(res, stock, { movements }).total, 4);
    assert.equal(stock[ITEM_A].currentStock, 6);
    assert.equal(stock[ITEM_A].reservedStock, 0);
    assert.equal(hasConsumedStock(res), true);

    const result = cancel(res, stock, movements, { reason: "MANAGER_CANCELLED", actorId: STAFF });
    assert.equal(result.action, "VOIDED");
    assert.equal(stock[ITEM_A].currentStock, 6, "physical stock must not come back");
    assert.equal(stock[ITEM_A].reservedStock, 0);
    assert.equal(availableOf(stock[ITEM_A]), 6, "voided stock is not sellable again");
    assert.equal(res.voids.length, 1);
    assert.equal(res.voids[0].phase, "AFTER_PREPARATION");
    assert.equal(res.voids[0].source, "ORDER");
    assert.equal(res.voids[0].reason, "MANAGER_CANCELLED");
    assert.equal(movements[0].reason, "Waste");
    assert.equal(movements[0].voidReason, "MANAGER_CANCELLED");
  });

  test("payment after preparation is an idempotent fallback and cannot deduct twice", () => {
    const stock = stockOf({ [ITEM_A]: { currentStock: 10 } });
    const item = requirement(ITEM_A, "kg", 4, stock);
    const res = reservation("order-paid", [item]);
    const movements = [];

    assert.equal(consume(res, stock, { trigger: "PREPARING", movements }).total, 4);
    const afterPrep = stock[ITEM_A].currentStock;

    const payment = consume(res, stock, { trigger: "PAYMENT", movements });
    assert.equal(payment.consumed, false);
    assert.equal(payment.plan, "ALREADY_CONSUMED");
    assert.equal(stock[ITEM_A].currentStock, afterPrep);
    assert.equal(res.consumedTrigger, "PREPARING", "the original trigger is preserved");
    assert.equal(movements.length, 1);
  });

  test("repeated preparation transition does not consume twice", () => {
    const stock = stockOf({ [ITEM_A]: { currentStock: 8 } });
    const item = requirement(ITEM_A, "kg", 3, stock);
    const res = reservation("order-repeat", [item]);
    const movements = [];

    assert.equal(consume(res, stock, { trigger: "PREPARING", movements }).total, 3);
    const afterFirst = stock[ITEM_A].currentStock;

    const second = consume(res, stock, { trigger: "PREPARING", movements });
    assert.equal(second.consumed, false);
    assert.equal(second.plan, "ALREADY_CONSUMED");
    assert.equal(stock[ITEM_A].currentStock, afterFirst);
    assert.equal(movements.length, 1);
  });

  test("concurrent/duplicate consumption claims the reservation once", () => {
    const stock = stockOf({ [ITEM_A]: { currentStock: 5 } });
    const item = requirement(ITEM_A, "kg", 5, stock);
    const res = reservation("order-duplicate", [item]);
    const movements = [];

    const first = consume(res, stock, { movements });
    // A second request that read RESERVED before the first committed reaches
    // the claim and observes the consumed state instead of decrementing again.
    const duplicate = consume(res, stock, { movements });

    assert.equal(first.consumed, true);
    assert.equal(duplicate.consumed, false);
    assert.equal(stock[ITEM_A].currentStock, 0);
    assert.equal(stock[ITEM_A].reservedStock, 0);
    assert.equal(movements.length, 1);
  });

  test("partial line cancellation after preparation keeps stock and does not reclassify movements", () => {
    const stock = stockOf({ [ITEM_A]: { currentStock: 10 }, [ITEM_B]: { currentStock: 10 } });
    const items = [
      { ...requirement(ITEM_A, "kg", 2, stock), lineId: LINE_1, type: "FOOD" },
      { ...requirement(ITEM_B, "kg", 3, stock), lineId: LINE_2, type: "DRINK" },
    ];
    const res = reservation("order-partial", items);
    const movements = [];
    consume(res, stock, { movements });
    assert.equal(stock[ITEM_A].currentStock, 8);
    assert.equal(stock[ITEM_B].currentStock, 7);

    const first = cancel(res, stock, movements, {
      source: "LINE",
      lineId: LINE_1,
      station: "KITCHEN",
      reason: "Dropped",
      actorId: STAFF,
    });
    assert.equal(first.action, "VOIDED");
    assert.equal(stock[ITEM_A].currentStock, 8, "partially cancelled line is not restored");
    assert.equal(stock[ITEM_B].currentStock, 7);
    assert.equal(res.voids.length, 1);
    assert.equal(res.voids[0].source, "LINE");
    assert.equal(res.voids[0].lineId, LINE_1);
    assert.equal(res.voids[0].station, "KITCHEN");
    assert.ok(movements.every((m) => m.reason === "SaleDeduction"), "line void must not reclassify whole-order movements");

    const repeat = cancel(res, stock, movements, {
      source: "LINE",
      lineId: LINE_1,
      station: "KITCHEN",
      reason: "Dropped",
      actorId: STAFF,
    });
    assert.equal(repeat.action, "NOOP_DUPLICATE_VOID");
    assert.equal(res.voids.length, 1);
  });

  test("mixed-station order consumes once at the first station and allows the second", () => {
    const stock = stockOf({ [ITEM_A]: { currentStock: 6 }, [ITEM_B]: { currentStock: 6 } });
    const items = [
      { ...requirement(ITEM_A, "kg", 2, stock), type: "FOOD" },
      { ...requirement(ITEM_B, "kg", 1, stock), type: "DRINK" },
    ];
    const res = reservation("order-mixed", items);
    const movements = [];

    // KITCHEN starts first: the whole order is committed.
    assert.equal(consume(res, stock, { trigger: "PREPARING", movements }).total, 3);
    assert.equal(stock[ITEM_A].currentStock, 4);
    assert.equal(stock[ITEM_B].currentStock, 5);

    // BARISTA start: the readiness gate accepts a consumed reservation and the
    // consumption hook is a no-op.
    assert.equal(hasConsumedStock(res), true);
    const barista = consume(res, stock, { trigger: "PREPARING", movements });
    assert.equal(barista.consumed, false);
    assert.equal(barista.plan, "ALREADY_CONSUMED");
    assert.equal(stock[ITEM_A].currentStock, 4);
    assert.equal(stock[ITEM_B].currentStock, 5);
    assert.equal(movements.length, 2);
  });

  test("Manager-approved shortage stays a shortage and consumes only physical stock", () => {
    const stock = stockOf({ [ITEM_A]: { currentStock: 2 } });
    const item = requirement(ITEM_A, "kg", 5, stock);
    assert.equal(item.reservedQuantity, 2);
    assert.equal(item.shortageQuantity, 3);

    const res = reservation("order-shortage", [item], {
      status: "APPROVED",
      approval: {
        managerId: STAFF,
        reason: "Known shortage",
        shortageFingerprint: "fp",
        shortages: [{ inventoryItemId: ITEM_A, shortageQuantity: 3 }],
      },
    });
    const movements = [];
    consume(res, stock, { movements });

    assert.equal(stock[ITEM_A].currentStock, 0);
    assert.equal(stock[ITEM_A].reservedStock, 0);
    assert.equal(res.items[0].consumedQuantity, 2);
    assert.equal(res.items[0].shortageQuantity, 3, "the approved shortage is preserved");
    assert.ok(res.approval, "approval record is preserved");

    cancel(res, stock, movements, { reason: "CANCELLED", actorId: STAFF });
    assert.equal(stock[ITEM_A].currentStock, 0, "consumed shortage stock is not restored");
    assert.equal(res.voids.length, 1);
  });

  test("waste accounting reclassifies sale movements once and preserves cost", () => {
    const stock = stockOf({ [ITEM_A]: { currentStock: 10 }, [ITEM_B]: { currentStock: 10 } });
    const items = [requirement(ITEM_A, "kg", 2, stock), requirement(ITEM_B, "kg", 1, stock)];
    const res = reservation("order-waste", items);
    const movements = [];
    consume(res, stock, { movements });

    const costBefore = movements.reduce((s, m) => s + m.totalCost, 0);
    cancel(res, stock, movements, { source: "ORDER", reason: "CUSTOMER_CANCELLED", actorId: STAFF });

    assert.equal(movements.filter((m) => m.reason === "Waste").length, 2);
    assert.equal(movements.reduce((s, m) => s + m.totalCost, 0), costBefore);
    const wasteTotal = movements
      .filter((m) => m.reason === "Waste")
      .reduce((s, m) => s + m.totalCost, 0);
    assert.equal(wasteTotal, costBefore);

    const repeat = cancel(res, stock, movements, {
      source: "ORDER",
      reason: "CUSTOMER_CANCELLED",
      actorId: STAFF,
    });
    assert.equal(repeat.action, "NOOP_DUPLICATE_VOID");
    assert.equal(res.voids.length, 1);
    assert.equal(movements.filter((m) => m.reason === "Waste").length, 2);
  });

  test("reservation release is idempotent before preparation", () => {
    const stock = stockOf({ [ITEM_A]: { currentStock: 10 } });
    const item = requirement(ITEM_A, "kg", 4, stock);
    const res = reservation("order-release-idem", [item]);

    const first = cancel(res, stock, []);
    const second = cancel(res, stock, []);

    assert.equal(first.action, "RELEASED");
    assert.equal(second.action, "NOOP_ALREADY_RELEASED");
    assert.equal(stock[ITEM_A].currentStock, 10);
    assert.equal(stock[ITEM_A].reservedStock, 0, "hold is returned exactly once");
    assert.equal(res.status, "RELEASED");
  });

  test("archive after preparation preserves consumed evidence without voiding", () => {
    const stock = stockOf({ [ITEM_A]: { currentStock: 10 } });
    const item = requirement(ITEM_A, "kg", 4, stock);
    const res = reservation("order-archive", [item]);
    const movements = [];
    consume(res, stock, { movements });

    const archived = cancel(res, stock, movements, { reason: "ARCHIVED", recordVoid: false });
    assert.equal(archived.action, "PRESERVED_CONSUMED");
    assert.equal(stock[ITEM_A].currentStock, 6);
    assert.equal(res.voids.length, 0);
    assert.ok(movements.every((m) => m.reason === "SaleDeduction"));
  });
});

describe("Phase 1.1 lifecycle — source contracts", () => {
  const orderService = src("lib/orderService.js");
  const reservationService = src("lib/inventoryReservationService.js");
  const reservationModel = src("lib/models/InventoryReservation.js");
  const movementModel = src("lib/models/StockMovement.js");

  test("PREPARING consumes before the atomic station write", () => {
    const update = orderService.slice(
      orderService.indexOf("export async function updateOrderStatus"),
      orderService.indexOf("export async function serveOrder")
    );
    const gate = update.indexOf("assertOrderInventoryReady(conn, pre)");
    const consumeAt = update.indexOf('consumeOrderInventory(conn, pre, {');
    const write = update.indexOf("Order.findOneAndUpdate(filter, pipeline");
    assert.ok(gate > 0);
    assert.ok(consumeAt > gate, "consumption must follow the readiness gate");
    assert.ok(write > consumeAt, "consumption must happen before the station write");
    assert.ok(update.includes('trigger: "PREPARING"'));
  });

  test("payment remains an idempotent fallback and does not release consumed stock", () => {
    assert.ok(orderService.includes('consumeOrderInventory(conn, doc, { actorId, trigger: "PAYMENT" })'));
    assert.ok(orderService.includes("isOrderInventoryConsumed(conn, doc)"));
    assert.ok(reservationService.includes('if (plan === "ALREADY_CONSUMED")'));
    assert.ok(reservationService.includes('if (plan === "IN_PROGRESS")'));
  });

  test("cancellation/archive branches are phase-aware", () => {
    assert.ok(orderService.includes('releaseOrderInventory(conn, archived, { reason: "ARCHIVED", recordVoid: false })'));
    assert.ok(orderService.includes('recordPostPreparationVoid(conn, doc, {'));
    assert.ok(orderService.includes('source: "LINE"'));
    assert.ok(orderService.includes('source: "ORDER"'));
    assert.ok(orderService.includes("isOrderInventoryConsumed(conn, doc)"));
    assert.ok(orderService.includes("export async function cancelOrder(conn, identifier, opts = {})"));
    assert.ok(orderService.includes('const reason = reasonRaw || "MANAGER_CANCELLED";'));
    const route = src("app/api/orders/[id]/route.js");
    assert.ok(route.includes("cancelOrder(conn, sanitizedId, {"));
    assert.ok(route.includes("staffId: auth.payload.staffId"));
    assert.ok(route.includes("reason: validated.data.reason || \"MANAGER_CANCELLED\""));
  });

  test("preparation actor identity is propagated from both status routes", () => {
    const route = src("app/api/orders/[id]/route.js");
    const statusRoute = src("app/api/orders/[id]/status/route.js");
    for (const source of [route, statusRoute]) {
      assert.ok(source.includes('(s === "READY" || s === "PREPARING")'));
      assert.ok(source.includes("opts.staffId = sid"));
      assert.ok(source.includes("opts.staffRole = role"));
    }
  });

  test("reservation model exposes consumed/void audit fields", () => {
    for (const field of ["consumedTrigger", "voidedAt", "voidReason", "voidedBy", "voids"]) {
      assert.ok(InventoryReservationSchema.path(field), `missing ${field}`);
    }
    assert.ok(reservationModel.includes("ReservationVoidSchema"));
    assert.ok(reservationModel.includes('"AFTER_PREPARATION"'));
    for (const field of ["voidedAt", "voidReason", "voidedBy"]) {
      assert.ok(StockMovementSchema.path(field), `StockMovement missing ${field}`);
    }
    assert.ok(movementModel.includes("voidReason"));
  });

  test("release/consumption rules are implemented as single atomic claims", () => {
    assert.ok(reservationService.includes('status: { $in: ["RESERVED", "APPROVED", "NO_INVENTORY"] }'));
    assert.ok(reservationService.includes('{ $set: { status: "CONSUMING" } }'));
    assert.ok(reservationService.includes("currentStock: { $gte: consumeQty }"));
    assert.ok(reservationService.includes("reservedStock: { $gte: consumeQty }"));
    assert.ok(reservationService.includes('status: { $nin: ["RELEASED", "CONSUMED"] }'));
    assert.ok(reservationService.includes('status: "CONSUMED"'));
    assert.ok(reservationService.includes("appendPostPreparationVoid"));
  });

  test("low/out stock calculations use available stock", () => {
    const alerts = src("lib/inventoryAlertService.js");
    const dashboard = src("lib/inventoryDashboardService.js");
    const itemsRoute = src("app/api/inventory/items/route.js");
    const ui = src("app/components/InventoryUI.jsx");
    assert.ok(alerts.includes("availableStock"));
    assert.ok(alerts.includes('$ifNull: ["$reservedStock", 0]'));
    assert.ok(dashboard.includes("availableStock"));
    assert.ok(dashboard.includes("$multiply: [\"$currentStock\", \"$cost\"]"), "physical value stays currentStock * cost");
    assert.ok(itemsRoute.includes("reservedStock"));
    assert.ok(ui.includes("availableStock"));
  });

  test("clear-orders preserves consumed reservations but returns live holds", () => {
    const clear = src("app/api/manager/settings/clear-orders/route.js");
    assert.ok(clear.includes('Reservation.deleteMany({ status: { $nin: ["CONSUMED", "CONSUMING"] } })'));
    assert.ok(clear.includes('$set: { reservedStock: 0 }'));
    assert.ok(clear.includes('"CONSUMED", "CONSUMING"'));
  });
});
