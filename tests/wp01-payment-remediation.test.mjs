// WP-01 follow-up remediation — G-PAY-1 blockers R-2, R-3, R-4, R-5, R-7.
//
// DB-FREE ONLY. No MongoDB connection is opened and no environment file is
// read. The suite locks the narrow follow-up contract:
//
//   * both public PATCH routes dispatch an already-PAID order to payOrder;
//   * a method-only TRANSFER assertion is structurally valid and reaches
//     updatePayment, which answers 409 PAYMENT_METHOD_IMMUTABLE when frozen;
//   * a frozen TRANSFER retry does not look up or require an active account;
//   * stored paymentAccountId/paymentAccountSnapshot are never rewritten;
//   * new unpaid TRANSFER submissions still require an account;
//   * a concurrent freeze cannot be overwritten by a stale updatePayment;
//   * legacy PAID orders with paidAt: null stay frozen;
//   * the central logger redacts account-number variants at every depth.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { validateOrderStatusUpdate } from "../lib/validate.js";
import { can, canTransition } from "../lib/policy.js";
import { redactForLog, logEvent, isSensitiveLogKey } from "../lib/operationalLogger.js";
import { VALID_PAYMENT_METHODS } from "../lib/constants.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const service = src("lib/orderService.js");
const orderRoute = src("app/api/orders/[id]/route.js");
const statusRoute = src("app/api/orders/[id]/status/route.js");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const pay = sliceBetween(service, "export async function payOrder", "export async function archiveOrder");
const update = sliceBetween(
  service,
  "export async function updatePayment",
  "// Shape consumed by the Waiter UI"
);

// Execute the real exported pure helpers in isolation (repo convention).
const helperBlock = sliceBetween(
  service,
  "export const PAYMENT_METHOD_IMMUTABLE",
  "export async function payOrder"
).replace(/\bexport\s+/g, "");
const helpers = new Function(
  "VALID_PAYMENT_METHODS",
  helperBlock +
    "\nreturn { PAYMENT_METHOD_IMMUTABLE, normalizePaymentMethodForWrite, paymentMethodsEquivalent, isFrozenPaymentIdentity, paymentMethodImmutableError };"
)(VALID_PAYMENT_METHODS);

// Run the real service functions against a small in-memory Order model. Only
// dependency-free paths are exercised: frozen retries and the pre-PAID write.
function fakeOrderModel({ findOneResults, updated = null }) {
  const calls = { findOne: 0, findOneAndUpdate: [] };
  let index = 0;
  const chain = (value) => {
    const query = {
      select: () => query,
      lean: () => Promise.resolve(value),
      then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    };
    return query;
  };
  return {
    calls,
    model: {
      findOne() {
        calls.findOne += 1;
        const value = findOneResults[Math.min(index, findOneResults.length - 1)];
        index += 1;
        return chain(value);
      },
      async findOneAndUpdate(filter, pipeline, options) {
        calls.findOneAndUpdate.push({ filter, pipeline, options });
        return updated;
      },
    },
  };
}

const makePayOrder = new Function(
  "getOrderModel",
  "mongoose",
  "logEvent",
  "applyPaidInventory",
  "assertOrderInventoryPayable",
  "buildOrderQuery",
  "normalizePaymentMethodForWrite",
  "isFrozenPaymentIdentity",
  "paymentMethodsEquivalent",
  pay.replace("export async function payOrder", "async function payOrder") +
    "\nreturn payOrder;"
);

const makeUpdatePayment = new Function(
  "getOrderModel",
  "logEvent",
  "buildOrderQuery",
  "normalizePaymentMethodForWrite",
  "isFrozenPaymentIdentity",
  "paymentMethodsEquivalent",
  "paymentMethodImmutableError",
  update.replace("export async function updatePayment", "async function updatePayment") +
    "\nreturn updatePayment;"
);

const noopInventory = async () => {};
const queryFor = (identifier) => ({ orderNumber: identifier });
const fakeMongoose = {
  isValidObjectId: () => true,
  Types: { ObjectId: class FakeObjectId {} },
};

const OLD_ACCOUNT_ID = "64b000000000000000000001";
const OTHER_ACCOUNT_ID = "64b000000000000000000002";
const SNAPSHOT = { bankName: "CBE", ownerName: "Abebe", accountNumber: "1000123456789" };

function frozenTransfer(overrides = {}) {
  return {
    _id: "64c000000000000000000001",
    orderNumber: "ORD-1001",
    status: "PAID",
    paidAt: new Date("2026-01-01T00:00:00.000Z"),
    paymentMethod: "TRANSFER",
    paymentAccountId: OLD_ACCOUNT_ID,
    paymentAccountSnapshot: { ...SNAPSHOT },
    ...overrides,
  };
}

function frozenCash(overrides = {}) {
  return {
    _id: "64c000000000000000000002",
    orderNumber: "ORD-1002",
    status: "PAID",
    paidAt: new Date("2026-01-01T00:00:00.000Z"),
    paymentMethod: "CASH",
    paymentAccountId: null,
    paymentAccountSnapshot: null,
    ...overrides,
  };
}

describe("R-2 — PAID retry reaches payOrder through the public routes", () => {
  test("both PATCH routes dispatch an existing PAID order to payOrder", () => {
    const orderPaidBranch = sliceBetween(orderRoute, 'if (s === "PAID")', "// PREPARING / READY");
    const statusPaidBranch = sliceBetween(statusRoute, 'if (s === "PAID")', "const opts = {};");
    for (const [label, branch] of [
      ["orders/[id]", orderPaidBranch],
      ["orders/[id]/status", statusPaidBranch],
    ]) {
      assert.ok(
        branch.includes('existingForPay.status === "PAID"'),
        `${label} must recognize an already-PAID order`
      );
      assert.ok(branch.includes("payOrder("), `${label} must reach payOrder on a PAID retry`);
      assert.ok(
        branch.indexOf('existingForPay.status === "PAID"') <
          branch.indexOf("Order must be submitted for verification before payment"),
        `${label} retry must be decided before the unrelated 400`
      );
    }
  });

  test("authorization and ownership gates are unchanged by the retry path", () => {
    assert.ok(orderRoute.includes('sUpper === "PAID" && !can(auth.payload.role, "orders:payment:confirm")'));
    assert.ok(statusRoute.includes('raw==="PAID" && !can(auth.payload.role,"orders:payment:confirm")'));
    assert.equal(can("CASHIER", "orders:payment:confirm"), true);
    assert.equal(can("MANAGER", "orders:payment:confirm"), true);
    assert.equal(can("WAITER", "orders:payment:confirm"), false);
    assert.equal(canTransition("CASHIER", "PAID"), true);
    assert.equal(canTransition("WAITER", "PAID"), false);
    // The WAITER ownership check still runs before the PAID branch in both routes.
    assert.ok(orderRoute.includes('String(existing.waiterId || "") !== String(auth.payload.staffId || "")'));
    assert.ok(statusRoute.includes('String(existing.waiterId || "") !== String(auth.payload.staffId || "")'));
  });

  test("a same-method PAID retry is an idempotent 200 and keeps one identity", async () => {
    const stored = frozenCash();
    const fake = fakeOrderModel({ findOneResults: [stored], updated: stored });
    const payOrder = makePayOrder(
      () => fake.model,
      fakeMongoose,
      () => {},
      noopInventory,
      noopInventory,
      queryFor,
      helpers.normalizePaymentMethodForWrite,
      helpers.isFrozenPaymentIdentity,
      helpers.paymentMethodsEquivalent
    );
    const doc = await payOrder({}, "ORD-1002", {
      paymentMethod: "CASH",
      actorId: "staff-1",
    });
    assert.equal(doc, stored);
    assert.equal(doc.paymentMethod, "CASH");
    assert.equal(doc.paidAt.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(fake.calls.findOneAndUpdate.length, 1, "payment commits in one atomic write");
    assert.deepEqual(fake.calls.findOneAndUpdate[0].filter.status, {
      $in: ["SERVED", "READY", "PAID"],
    });
    assert.equal(fake.calls.findOneAndUpdate[0].options.updatePipeline, true);
  });
});

describe("R-3 — different-method PAID retry is a 409, not a premature 400", () => {
  test("a method-only TRANSFER assertion is structurally valid", () => {
    const r = validateOrderStatusUpdate({ paymentMethod: "TRANSFER" });
    assert.equal(r.ok, true);
    assert.equal(r.data.paymentMethod, "TRANSFER");
    assert.equal(r.data.paymentAccountId, undefined);
    assert.equal(r.data.status, undefined);
  });

  test("the method-only branch reaches updatePayment and maps its 409 + code", () => {
    assert.ok(orderRoute.includes("} else if (paymentMethod) {"));
    assert.ok(
      orderRoute.includes(
        "updatePayment(conn, sanitizedId, { paymentMethod, actorId: auth.payload.staffId })"
      )
    );
    for (const route of [orderRoute, statusRoute]) {
      assert.ok(route.includes("Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599"));
      assert.ok(route.includes("return fail(msg, err.status, err.code)"));
    }
    // No authorization widening: method-only updates keep the existing policy.
    assert.ok(orderRoute.includes('if (!can(auth.payload.role, "orders:payment"))'));
    assert.equal(can("MANAGER", "orders:payment"), true);
  });

  test("updatePayment throws the stable 409 for a frozen different method", async () => {
    const stored = frozenCash();
    const fake = fakeOrderModel({ findOneResults: [stored] });
    const updatePayment = makeUpdatePayment(
      () => fake.model,
      () => {},
      queryFor,
      helpers.normalizePaymentMethodForWrite,
      helpers.isFrozenPaymentIdentity,
      helpers.paymentMethodsEquivalent,
      helpers.paymentMethodImmutableError
    );
    await assert.rejects(
      updatePayment({}, "ORD-1002", { paymentMethod: "TRANSFER", actorId: "manager-1" }),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, "PAYMENT_METHOD_IMMUTABLE");
        return true;
      }
    );
    assert.equal(fake.calls.findOneAndUpdate.length, 0, "a frozen conflict never writes");
    assert.equal(stored.paymentMethod, "CASH", "the stored identity is untouched");
  });

  test("same-method updatePayment on PAID is a no-write 200", async () => {
    const stored = frozenCash();
    const fake = fakeOrderModel({ findOneResults: [stored] });
    const updatePayment = makeUpdatePayment(
      () => fake.model,
      () => {},
      queryFor,
      helpers.normalizePaymentMethodForWrite,
      helpers.isFrozenPaymentIdentity,
      helpers.paymentMethodsEquivalent,
      helpers.paymentMethodImmutableError
    );
    const doc = await updatePayment({}, "ORD-1002", { paymentMethod: "CASH", actorId: "manager-1" });
    assert.equal(doc, stored);
    assert.equal(fake.calls.findOneAndUpdate.length, 0);
  });
});

describe("R-4/R-5 — frozen TRANSFER retries and account validation", () => {
  test("a frozen TRANSFER retry never looks up an inactive/unavailable account", async () => {
    const stored = frozenTransfer();
    const fake = fakeOrderModel({ findOneResults: [stored], updated: stored });
    const payOrder = makePayOrder(
      () => fake.model,
      fakeMongoose,
      () => {},
      noopInventory,
      noopInventory,
      queryFor,
      helpers.normalizePaymentMethodForWrite,
      helpers.isFrozenPaymentIdentity,
      helpers.paymentMethodsEquivalent
    );
    // The new account id is deliberately not resolvable through PaymentInfo:
    // the frozen path must not attempt the lookup at all.
    const doc = await payOrder({}, "ORD-1001", {
      paymentMethod: "TRANSFER",
      paymentAccountId: OTHER_ACCOUNT_ID,
      actorId: "cashier-1",
    });
    assert.equal(doc, stored);
    assert.equal(doc.paymentAccountId, OLD_ACCOUNT_ID);
    assert.equal(doc.paymentAccountSnapshot.accountNumber, SNAPSHOT.accountNumber);

    const $set = fake.calls.findOneAndUpdate[0].pipeline[0].$set;
    assert.ok(!("paymentAccountId" in $set), "frozen retry must not rewrite the account id");
    assert.ok(!("paymentAccountSnapshot" in $set), "frozen retry must not rewrite the snapshot");
    assert.equal($set.paymentMethod.$cond[2], "$paymentMethod");
    assert.equal($set.paidAt.$cond[2], "$paidAt");
  });

  test("the account lookup is gated by the frozen marker", () => {
    const frozenGate = pay.indexOf("frozenIdentity = isFrozenPaymentIdentity(current)");
    const lookup = pay.indexOf("PaymentInfo.findOne");
    const disabled = pay.indexOf('throw new Error("Payment account is disabled")');
    const cashBranch = pay.indexOf('} else if (pm === "CASH")');
    assert.ok(frozenGate > 0 && lookup > frozenGate, "the freeze check runs before the account lookup");
    assert.ok(disabled > frozenGate && disabled < cashBranch, "the active-account rule stays on new transfers");
    assert.ok(pay.includes('if (!frozenIdentity) {'));
  });

  test("a different-method payOrder retry preserves the identity and logs no account data", async () => {
    const stored = frozenCash();
    const events = [];
    const fake = fakeOrderModel({ findOneResults: [stored], updated: stored });
    const payOrder = makePayOrder(
      () => fake.model,
      fakeMongoose,
      (level, event, fields) => events.push({ level, event, fields }),
      noopInventory,
      noopInventory,
      queryFor,
      helpers.normalizePaymentMethodForWrite,
      helpers.isFrozenPaymentIdentity,
      helpers.paymentMethodsEquivalent
    );
    const doc = await payOrder({}, "ORD-1002", {
      paymentMethod: "TRANSFER",
      paymentAccountId: OTHER_ACCOUNT_ID,
      actorId: "cashier-1",
    });
    const $set = fake.calls.findOneAndUpdate[0].pipeline[0].$set;
    assert.equal($set.paymentMethod.$cond[2], "$paymentMethod");
    assert.ok(!("paymentAccountId" in $set));
    assert.equal(doc.paymentMethod, "CASH");
    const preserved = events.find((e) => e.event === "payment_method_preserved");
    assert.ok(preserved, "the preserved-identity event is emitted");
    assert.equal(preserved.fields.storedMethod, "CASH");
    assert.equal(preserved.fields.requestedMethod, "TRANSFER");
    assert.doesNotMatch(
      JSON.stringify(preserved.fields),
      /accountNumber|bankName|ownerName|paymentAccountSnapshot|pin/i
    );
  });

  test("a legacy PAID order with paidAt null is frozen for TRANSFER retries", async () => {
    const stored = frozenTransfer({ paidAt: null });
    const fake = fakeOrderModel({ findOneResults: [stored], updated: stored });
    const payOrder = makePayOrder(
      () => fake.model,
      fakeMongoose,
      () => {},
      noopInventory,
      noopInventory,
      queryFor,
      helpers.normalizePaymentMethodForWrite,
      helpers.isFrozenPaymentIdentity,
      helpers.paymentMethodsEquivalent
    );
    const doc = await payOrder({}, "ORD-1001", {
      paymentMethod: "TRANSFER",
      paymentAccountId: OTHER_ACCOUNT_ID,
      actorId: "cashier-1",
    });
    const $set = fake.calls.findOneAndUpdate[0].pipeline[0].$set;
    assert.equal(doc.paymentAccountId, OLD_ACCOUNT_ID);
    assert.ok(!("paymentAccountId" in $set));
    assert.equal(helpers.isFrozenPaymentIdentity(stored), true);
  });

  test("new unpaid TRANSFER still requires a selected account", async () => {
    const unpaid = {
      _id: "64c000000000000000000003",
      orderNumber: "ORD-1003",
      status: "SERVED",
      paidAt: null,
      paymentMethod: null,
      paymentAccountId: null,
      paymentAccountSnapshot: null,
    };
    const fake = fakeOrderModel({ findOneResults: [unpaid] });
    const payOrder = makePayOrder(
      () => fake.model,
      fakeMongoose,
      () => {},
      noopInventory,
      noopInventory,
      queryFor,
      helpers.normalizePaymentMethodForWrite,
      helpers.isFrozenPaymentIdentity,
      helpers.paymentMethodsEquivalent
    );
    await assert.rejects(
      payOrder({}, "ORD-1003", { paymentMethod: "TRANSFER", actorId: "cashier-1" }),
      /paymentAccountId is required for Transfer payments/
    );
    assert.equal(fake.calls.findOneAndUpdate.length, 0, "no write without a transfer account");

    const pending = validateOrderStatusUpdate({
      status: "PAYMENT_PENDING",
      paymentMethod: "TRANSFER",
    });
    assert.equal(pending.ok, undefined);
    assert.match(pending.error, /paymentAccountId is required/);
    const paid = validateOrderStatusUpdate({ status: "PAID", paymentMethod: "TRANSFER" });
    assert.equal(paid.ok, undefined, "the existing PAID-without-account contract is preserved");
    const withAccount = validateOrderStatusUpdate({
      status: "PAYMENT_PENDING",
      paymentMethod: "TRANSFER",
      paymentAccountId: new mongoose.Types.ObjectId().toString(),
    });
    assert.equal(withAccount.ok, true);
  });
});

describe("concurrent payment identity cannot be overwritten", () => {
  test("a stale pre-read loses to a concurrent freeze and re-reads to a 409", async () => {
    const before = {
      _id: "64c000000000000000000004",
      orderNumber: "ORD-1004",
      status: "SERVED",
      paidAt: null,
      paymentMethod: "CASH",
      paymentAccountId: null,
      paymentAccountSnapshot: null,
    };
    const afterFreeze = frozenCash({ _id: before._id, orderNumber: before.orderNumber });
    const fake = fakeOrderModel({ findOneResults: [before, afterFreeze], updated: null });
    const updatePayment = makeUpdatePayment(
      () => fake.model,
      () => {},
      queryFor,
      helpers.normalizePaymentMethodForWrite,
      helpers.isFrozenPaymentIdentity,
      helpers.paymentMethodsEquivalent,
      helpers.paymentMethodImmutableError
    );
    await assert.rejects(
      updatePayment({}, "ORD-1004", { paymentMethod: "TRANSFER", actorId: "manager-1" }),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, "PAYMENT_METHOD_IMMUTABLE");
        return true;
      }
    );
    assert.equal(afterFreeze.paymentMethod, "CASH");
    const write = fake.calls.findOneAndUpdate[0];
    assert.equal(write.filter.paidAt, null, "the write is guarded by the freeze marker");
    assert.deepEqual(write.filter.status, { $ne: "PAID" });
  });

  test("a stale same-method update returns the frozen order without writing", async () => {
    const before = {
      _id: "64c000000000000000000005",
      orderNumber: "ORD-1005",
      status: "SERVED",
      paidAt: null,
      paymentMethod: "CASH",
      paymentAccountId: null,
      paymentAccountSnapshot: null,
    };
    const afterFreeze = frozenCash({ _id: before._id, orderNumber: before.orderNumber });
    const fake = fakeOrderModel({ findOneResults: [before, afterFreeze], updated: null });
    const updatePayment = makeUpdatePayment(
      () => fake.model,
      () => {},
      queryFor,
      helpers.normalizePaymentMethodForWrite,
      helpers.isFrozenPaymentIdentity,
      helpers.paymentMethodsEquivalent,
      helpers.paymentMethodImmutableError
    );
    const doc = await updatePayment({}, "ORD-1005", { paymentMethod: "CASH", actorId: "manager-1" });
    assert.equal(doc, afterFreeze);
    assert.equal(doc.paidAt.toISOString(), "2026-01-01T00:00:00.000Z");
  });

  test("payOrder's first-identity write is conditional on the live freeze marker", () => {
    assert.match(
      pay,
      /paymentMethod:\s*\{\s*\$cond:\s*\[isFirstPayment,\s*firstPayment\.paymentMethod,\s*"\$paymentMethod"\]/
    );
    assert.match(
      pay,
      /paymentAccountSnapshot:\s*\{\s*\$cond:\s*\[isFirstPayment,\s*firstPayment\.paymentAccountSnapshot,\s*"\$paymentAccountSnapshot"\]/
    );
    assert.match(pay, /\$ne: \["\$status", "PAID"\]/);
  });
});

describe("R-7 — central logger redacts account numbers in nested shapes", () => {
  test("recognizes account-number key variants but keeps ordinary identifiers", () => {
    for (const key of [
      "accountNumber",
      "account_number",
      "ACCOUNT-NUMBER",
      "accountNo",
      "account_no",
      "acctNo",
      "acct_no",
      "iban",
      "IBAN",
    ]) {
      assert.equal(isSensitiveLogKey(key), true, `${key} must be redacted`);
    }
    for (const key of ["orderId", "paymentAccountId", "bankName", "ownerName", "staffId"]) {
      assert.equal(isSensitiveLogKey(key), false, `${key} is safe`);
    }
  });

  test("redacts account numbers at every depth, including arrays and snapshots", () => {
    const safe = redactForLog({
      orderId: "ORD-1001",
      paymentAccountId: OLD_ACCOUNT_ID,
      paymentAccountSnapshot: { bankName: "CBE", ownerName: "Abebe", accountNumber: "1000123456789" },
      nested: {
        deeper: [
          { accountNo: "111" },
          { account_number: "222" },
          { acctNo: "333" },
          { iban: "ET00" },
        ],
      },
      pin: "1234",
      token: "tok",
    });
    assert.equal(safe.paymentAccountId, OLD_ACCOUNT_ID, "account id is an identifier, not a number");
    assert.equal(safe.paymentAccountSnapshot.bankName, "CBE");
    assert.equal(safe.paymentAccountSnapshot.ownerName, "Abebe");
    assert.equal(safe.paymentAccountSnapshot.accountNumber, "[redacted]");
    for (const entry of safe.nested.deeper) {
      assert.deepEqual(Object.values(entry), ["[redacted]"]);
    }
    assert.equal(safe.pin, "[redacted]");
    assert.equal(safe.token, "[redacted]");
    assert.ok(!JSON.stringify(safe).includes("1000123456789"));
  });

  test("logEvent serializes a nested account snapshot with no raw account number", () => {
    const original = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
    const lines = [];
    console.log = (line) => lines.push(String(line));
    console.warn = (line) => lines.push(String(line));
    console.error = (line) => lines.push(String(line));
    console.debug = (line) => lines.push(String(line));
    try {
      logEvent("info", "wp01_logger_probe", {
        orderId: "ORD-1001",
        paymentAccountSnapshot: { ...SNAPSHOT },
        nested: { array: [{ accountNumber: "99887766" }] },
      });
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      console.debug = original.debug;
    }
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.paymentAccountSnapshot.accountNumber, "[redacted]");
    assert.equal(parsed.nested.array[0].accountNumber, "[redacted]");
    assert.ok(!lines[0].includes("1000123456789"));
    assert.ok(!lines[0].includes("99887766"));
  });
});
