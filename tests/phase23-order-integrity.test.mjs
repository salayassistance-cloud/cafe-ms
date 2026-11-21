// Phase 2.3 — transaction, concurrency, and financial-integrity regressions.
//
// DB-FREE ONLY. No MongoDB connection is opened and no environment file is
// read. These assertions lock the narrow corrections made in Phase 2.3 and the
// invariants that the real replica-set suite proves at runtime:
//
//   * terminal-state writes (pay/cancel/archive) are atomic and re-check the
//     state inside the update, never just after a read;
//   * consumption claims CONSUMING, decrements stock conditionally, writes one
//     idempotent SaleDeduction per (order, inventory item), and finalizes in the
//     same transaction;
//   * payment never rolls back because inventory failed, and an unconsumed hold
//     is released exactly once;
//   * array-pipeline stock updates are Mongoose 9 compatible;
//   * transaction errors are classified across driver error wrapping, retries
//     are bounded, unknown commits are never retried, and sessions always end.
//
// The real transaction proofs live in tests/integration/ and run only when the
// disposable replica-set flags are provided.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const orderService = src("lib/orderService.js");
const reservationService = src("lib/inventoryReservationService.js");
const transactionRunner = src("lib/transactionRunner.js");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

describe("Phase 2.3 — atomic terminal-state writes", () => {
  test("archiveOrder re-checks the terminal state inside the write", () => {
    const archive = sliceBetween(
      orderService,
      "export async function archiveOrder",
      "export async function cancelOrderByWaiter"
    );
    assert.match(
      archive,
      /findOneAndUpdate\(\s*\{\s*\.\.\.buildOrderQuery\(identifier\),\s*status: \{ \$nin: \["PAID", "ARCHIVED", "CANCELLED"\] \}/,
      "archive must never overwrite a concurrently committed PAID order"
    );
    assert.ok(archive.includes('throw new Error("Cannot archive a paid order")'));
    assert.ok(archive.includes("return existing"), "already ARCHIVED/CANCELLED must stay idempotent");
  });

  test("cancelOrder re-checks the terminal state inside the write", () => {
    const cancel = sliceBetween(
      orderService,
      "export async function cancelOrder",
      "export async function cancelOrderItem"
    );
    assert.match(
      cancel,
      /findOneAndUpdate\(\s*\{\s*\.\.\.buildOrderQuery\(identifier\),\s*status: \{ \$nin: \["PAID", "CANCELLED"\] \}/,
      "cancel must never revert a concurrently committed PAID order"
    );
    assert.ok(cancel.includes('throw new Error("Cannot cancel a paid or already-cancelled order")'));
  });

  test("payment is one atomic findOneAndUpdate with idempotent PAID retry", () => {
    const pay = sliceBetween(
      orderService,
      "export async function payOrder",
      "export async function archiveOrder"
    );
    assert.ok(pay.includes('status: { $in: ["SERVED", "READY", "PAID"] }'));
    assert.ok(
      pay.includes("const doc = await Order.findOneAndUpdate(filter, pipeline, {") &&
        pay.includes("updatePipeline: true"),
      "payment must commit in one conditional pipeline write"
    );
    assert.ok(pay.includes('paymentMethod: pm'), "payment method is supplied by the validated service path");
    assert.ok(
      pay.includes('const existing = await Order.findOne(buildOrderQuery(identifier))'),
      "the read is only a miss-path error mapper, never the write precondition"
    );
    assert.ok(
      pay.indexOf("Order.findOneAndUpdate(filter, pipeline") <
        pay.indexOf("await applyPaidInventory(conn, doc, actorId)"),
      "payment commits before inventory is attempted"
    );
  });
});

describe("Phase 2.3 — consumption transaction and identity", () => {
  test("consumption claims CONSUMING and only deducts conditionally", () => {
    assert.ok(
      reservationService.includes(
        'status: { $in: ["RESERVED", "APPROVED", "NO_INVENTORY"] }'
      )
    );
    assert.ok(reservationService.includes('{ $set: { status: "CONSUMING" } }'));
    assert.ok(reservationService.includes("currentStock: { $gte: consumeQty }"));
    assert.ok(reservationService.includes("reservedStock: { $gte: consumeQty }"));
    assert.ok(
      reservationService.includes(
        "{ $inc: { currentStock: -consumeQty, reservedStock: -consumeQty } }"
      )
    );
    assert.ok(
      reservationService.includes('throw new InventoryReservationError(\n              "Physical stock changed during consumption.'),
      "a lost conditional race must abort the transaction, not go negative"
    );
    assert.equal(
      /currentStock: \{ \$inc: -/.test(reservationService),
      false,
      "unconditional stock decrement must not exist"
    );
  });

  test("one stable server-authoritative idempotency key per order and item", () => {
    assert.ok(reservationService.includes("idempotencyKey: `sale:${String(orderId)}:${invId}`"));
    const saleKeySources = reservationService.match(/idempotencyKey:[^\n]*/g) || [];
    for (const line of saleKeySources) {
      assert.equal(
        /Date\.now|randomUUID|Math\.random|new Date\(\)/.test(line),
        false,
        `idempotency key must not be client/time derived: ${line.trim()}`
      );
    }
    assert.ok(
      reservationService.includes('return { success: true, skipped: true, warnings: ["Inventory already consumed"] }'),
      "a retried consumption must adopt the committed state"
    );
  });

  test("consumption finalizes in the same transaction and failures return (never throw)", () => {
    const consume = reservationService.slice(
      reservationService.indexOf("export async function consumeOrderInventory")
    );
    assert.ok(consume.includes("return await runInTransaction(conn, async (session) => {"));
    assert.ok(consume.includes('{ _id: claimed._id, status: "CONSUMING" }'));
    assert.ok(consume.includes('status: "CONSUMED"'));
    assert.ok(consume.includes("await StockMovement.insertMany(movements, { session })"));
    assert.match(
      consume,
      /catch \(err\) \{\s*return \{\s*success: false,/,
      "inventory failure must be reported, never thrown, because payment already committed"
    );
  });

  test("payment success tolerates inventory failure and releases only real holds", () => {
    const apply = sliceBetween(
      orderService,
      "async function applyPaidInventory",
      "export async function payOrder"
    );
    assert.ok(apply.includes("try {"));
    assert.ok(apply.includes("if (!result?.success)"));
    assert.ok(apply.includes("await runInventoryHook"));
    assert.ok(
      apply.includes("if (alreadyConsumed === false)"),
      "only a positively confirmed unconsumed verdict may release holds"
    );
    assert.ok(
      apply.includes(
        'releaseOrderInventory(conn, doc, { reason: "CONSUMPTION_FAILED", recordVoid: false })'
      ),
      "the payment-failure release must never record a void"
    );
    assert.ok(apply.includes('logEvent("error", "inventory_consumption_error"'));
    assert.equal(
      /\n\s*throw\s/.test(apply),
      false,
      "applyPaidInventory must never throw after payment commits"
    );
  });

  test("an inconclusive consumption probe preserves evidence and never voids", () => {
    const apply = sliceBetween(
      orderService,
      "async function applyPaidInventory",
      "export async function payOrder"
    );
    assert.equal(
      apply.includes("if (!alreadyConsumed)"),
      false,
      "a null or error probe must not be treated as 'not consumed'"
    );
    assert.ok(
      apply.includes("else if (alreadyConsumed !== true)"),
      "unknown commit and non-boolean verdicts are handled explicitly"
    );
    assert.ok(
      apply.includes('logEvent("error", "inventory_consumption_probe_unknown"'),
      "an inconclusive probe is a structured operational event"
    );
    assert.ok(apply.includes("probeResult:"), "the event records the verdict type only");
    assert.ok(apply.includes("consumptionCode:"), "the event records the typed result code");
    assert.ok(apply.includes("recordVoid: false"), "the second barrier is present");
  });

  test("post-preparation cancellation keeps the default void/reclassify behavior", () => {
    const cancel = sliceBetween(
      orderService,
      "export async function cancelOrder(",
      "export async function cancelOrderItem"
    );
    assert.ok(cancel.includes("releaseOrderInventory(conn, cancelled, {"));
    assert.equal(
      cancel.includes("recordVoid"),
      false,
      "manager cancellation must keep the default recordVoid: true behavior"
    );
  });

  test("post-preparation void retries are deduplicated and never restore stock", () => {
    assert.ok(reservationService.includes('filter["voids.lineId"] = { $ne: lineOid }'));
    assert.ok(reservationService.includes('filter["voids.source"] = { $ne: "ORDER" }'));
    assert.ok(reservationService.includes('{ $set: { reason: "Waste", voidedAt: now'));
    const voidBlock = sliceBetween(
      reservationService,
      "async function appendPostPreparationVoid",
      "// Record a line/whole-order void"
    );
    assert.equal(
      /\$inc:\s*\{\s*currentStock/.test(voidBlock),
      false,
      "cancelling consumed stock must not physically restore it"
    );
  });
});

describe("Phase 2.3 — transaction helper and error classification", () => {
  // OBS-3: the single retry policy now lives in lib/transactionRunner.js and the
  // reservation layer delegates to it. The assertions below pin the extracted
  // implementation plus the delegation, so reservation behavior cannot drift.
  const helper = sliceBetween(
    transactionRunner,
    "export async function runInTransaction",
    "export default runInTransaction"
  );

  test("the reservation layer delegates to the shared runner", () => {
    assert.ok(reservationService.includes("runInTransaction as runSharedTransaction"));
    assert.ok(reservationService.includes("return runSharedTransaction(conn, fn, {"));
    assert.ok(reservationService.includes("new InventoryReservationError(message, status, code)"));
    // No second retry policy may be reintroduced in the reservation service.
    assert.equal(reservationService.includes("attempt < 3"), false);
    assert.equal(reservationService.includes("attempt < 2"), false);
  });

  test("retries are bounded, transient-only, and never retry an unknown commit", () => {
    assert.ok(helper.includes("attempt < 3"), "bounded retry count");
    assert.ok(
      helper.includes(
        "isTransientTransactionError(err) && !isUnknownCommitResult(err) && attempt < 2"
      ),
      "unknown commit results must not be retried"
    );
    assert.ok(helper.includes("await session.abortTransaction()"));
    assert.ok(helper.includes("await session.endSession()"));
  });

  test("unsupported topology fails closed as 503 TRANSACTIONS_UNAVAILABLE", () => {
    assert.ok(helper.includes('"TRANSACTIONS_UNAVAILABLE"'));
    assert.ok(helper.includes("503"));
    assert.ok(
      transactionRunner.includes("does not support retryable writes"),
      "the driver wraps the standalone error; classification must follow the wrapper chain"
    );
  });

  test("error classification follows driver wrapping", () => {
    assert.ok(transactionRunner.includes("export function errorChain(err)"));
    assert.ok(transactionRunner.includes("current.originalError"));
    assert.ok(transactionRunner.includes("current.errorResponse?.originalError"));
    assert.ok(transactionRunner.includes("errorLabelSet"));
  });
});

describe("Phase 2.3 — Mongoose 9 array-pipeline compatibility", () => {
  test("every array-form reservedStock pipeline passes updatePipeline: true", () => {
    const marker = "reservedStock: {";
    let cursor = 0;
    let checked = 0;
    while ((cursor = reservationService.indexOf(marker, cursor)) !== -1) {
      const window = reservationService.slice(cursor, cursor + 1200);
      if (window.trimStart().startsWith("reservedStock: {\n") && window.includes("$max:")) {
        checked += 1;
        assert.ok(
          window.includes("updatePipeline: true"),
          "Mongoose 9 rejects array updates without updatePipeline: true"
        );
      }
      cursor += marker.length;
    }
    assert.equal(checked, 3, "reconcile, release, and consumption releaseQty");
  });
});

describe("Phase 2.3 — dead legacy deduction path", () => {
  test("API routes and the live order service never call executeInventoryDeduction", () => {
    const apiOrders = src("app/api/orders/[id]/route.js");
    const apiStatus = src("app/api/orders/[id]/status/route.js");
    for (const [name, body] of [
      ["orders/[id]", apiOrders],
      ["orders/[id]/status", apiStatus],
      ["orderService", orderService],
      ["inventoryReservationService", reservationService],
    ]) {
      assert.equal(
        body.includes("executeInventoryDeduction"),
        false,
        `${name} must not use the legacy unconditional executor`
      );
    }
  });

  test("the legacy executor is still documented as unwired and is not part of payment", () => {
    const legacy = src("lib/inventoryDeductionService.js");
    assert.ok(legacy.includes("SERVICE ONLY — NO INTEGRATION"));
    assert.ok(legacy.includes("export async function executeInventoryDeduction"));
  });
});

describe("Phase 2.3 — operator-facing destructive paths", () => {
  test("clear-orders refuses PAID evidence and reports CONSUMING reservations", () => {
    const clear = src("app/api/manager/settings/clear-orders/route.js");
    assert.ok(clear.includes('dryRun'), "preview must exist");
    assert.ok(clear.includes('"CLEAR-ORDERS"'), "literal confirmation token required");
    assert.ok(clear.includes('status: "PAID"'), "PAID orders are financial evidence");
    assert.ok(clear.includes('"CONSUMING"'), "in-flight consumption must be detected");
  });
});
