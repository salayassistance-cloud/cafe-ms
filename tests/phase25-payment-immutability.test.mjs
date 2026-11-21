// Phase 2.5 WP-01 — payment identity freeze after the first PAID.
//
// DB-FREE ONLY. No MongoDB connection is opened and no environment file is
// read. The suite locks the approved retry/error contract (Phase 2.5 blueprint
// §4.1.1) and the source shape that a disposable replica-set test then proves
// at runtime:
//
//   * the first PAID writes paymentMethod/account/snapshot exactly once;
//   * the lock marker is the existing paidAt field (no new schema field);
//   * every retry preserves the stored identity and never creates a second
//     payment;
//   * updatePayment is frozen on PAID (same method 200, different method
//     409 PAYMENT_METHOD_IMMUTABLE) and never stamps timestamps;
//   * the pre-PAID update is atomic against a concurrent payOrder;
//   * confirm/submit/reject payment semantics are untouched.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VALID_PAYMENT_METHODS } from "../lib/constants.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const service = src("lib/orderService.js");
const orderRoute = src("app/api/orders/[id]/route.js");
const statusRoute = src("app/api/orders/[id]/status/route.js");
const orderModel = src("lib/models/Order.js");

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
const submit = sliceBetween(
  service,
  "export async function submitPaymentForVerification",
  "// Cashier confirms pending payment"
);
const confirm = sliceBetween(service, "export async function confirmPayment", "// Cashier rejects pending payment");
const reject = sliceBetween(service, "export async function rejectPayment", "// Update payment fields independently");

// Execute the real exported pure helpers in isolation. The slice only contains
// dependency-free declarations; `export` is stripped so `new Function` can run
// it without resolving the module's `@/` imports.
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

describe("Phase 2.5 WP-01 — pure payment identity rules", () => {
  test("new writes normalize legacy TELEBIRR to canonical TRANSFER", () => {
    assert.equal(helpers.normalizePaymentMethodForWrite("CASH"), "CASH");
    assert.equal(helpers.normalizePaymentMethodForWrite("TRANSFER"), "TRANSFER");
    assert.equal(helpers.normalizePaymentMethodForWrite("TELEBIRR"), "TRANSFER");
    assert.equal(helpers.normalizePaymentMethodForWrite("NONE"), "NONE");
    assert.equal(helpers.normalizePaymentMethodForWrite("telebirr"), null);
    assert.equal(helpers.normalizePaymentMethodForWrite(undefined), null);
    assert.equal(helpers.normalizePaymentMethodForWrite("REFUND"), null);
  });

  test("requested/stored comparison treats TELEBIRR and TRANSFER as one identity", () => {
    assert.equal(helpers.paymentMethodsEquivalent("CASH", "CASH"), true);
    assert.equal(helpers.paymentMethodsEquivalent("TRANSFER", "TELEBIRR"), true);
    assert.equal(helpers.paymentMethodsEquivalent("TELEBIRR", "TRANSFER"), true);
    assert.equal(helpers.paymentMethodsEquivalent("CASH", "TRANSFER"), false);
    assert.equal(helpers.paymentMethodsEquivalent(null, "CASH"), false);
    assert.equal(helpers.paymentMethodsEquivalent("CASH", undefined), false);
    assert.equal(helpers.paymentMethodsEquivalent("NONE", "NONE"), true);
  });

  test("paidAt is the lock marker; legacy PAID with paidAt null stays frozen", () => {
    assert.equal(helpers.isFrozenPaymentIdentity(null), false);
    assert.equal(helpers.isFrozenPaymentIdentity({ status: "SERVED", paidAt: null }), false);
    assert.equal(helpers.isFrozenPaymentIdentity({ status: "SERVED", paidAt: new Date() }), true);
    assert.equal(helpers.isFrozenPaymentIdentity({ status: "PAID", paidAt: null }), true);
    assert.equal(helpers.isFrozenPaymentIdentity({ status: "PAID", paidAt: new Date() }), true);
    assert.equal(helpers.isFrozenPaymentIdentity({ status: "PAYMENT_PENDING" }), false);
  });

  test("the conflict carries the stable 409 PAYMENT_METHOD_IMMUTABLE contract", () => {
    assert.equal(helpers.PAYMENT_METHOD_IMMUTABLE, "PAYMENT_METHOD_IMMUTABLE");
    const err = helpers.paymentMethodImmutableError();
    assert.equal(err.status, 409);
    assert.equal(err.code, "PAYMENT_METHOD_IMMUTABLE");
    assert.equal(err.name, "PaymentIdentityError");
    assert.match(err.message, /cannot be changed|immutable/i);
  });

  test("no new schema field is introduced for the freeze", () => {
    assert.doesNotMatch(orderModel, /\bpaymentIdentityFrozen\b/);
    assert.doesNotMatch(orderModel, /\bpaymentLockedAt\b/);
    assert.doesNotMatch(orderModel, /\bfrozenAt\b/);
    assert.doesNotMatch(orderModel, /\borderVersion\b/);
    assert.doesNotMatch(orderModel, /\binventoryMode\b/);
  });
});

describe("Phase 2.5 WP-01 — payOrder first identity", () => {
  test("the PAID-eligible filter and single atomic pipeline are preserved", () => {
    assert.ok(pay.includes('status: { $in: ["SERVED", "READY", "PAID"] }'));
    assert.ok(pay.includes("const doc = await Order.findOneAndUpdate(filter, pipeline, {"));
    assert.ok(pay.includes("updatePipeline: true"));
    assert.equal((pay.match(/Order\.findOneAndUpdate\(/g) || []).length, 1, "payment must commit in one write");
  });

  test("paymentMethod is written only while paidAt is null", () => {
    assert.ok(
      !pay.includes("...(pm ? { paymentMethod: pm } : {})"),
      "the unconditional method set must be gone"
    );
    assert.ok(pay.includes("paymentMethod: pm"), "the validated method literal stays (Phase 2.3 contract)");
    assert.match(
      pay,
      /paymentMethod:\s*\{\s*\$cond:\s*\[isFirstPayment,\s*firstPayment\.paymentMethod,\s*"\$paymentMethod"\]/,
      "the method is guarded by the paidAt lock marker"
    );
    assert.match(
      pay,
      /const isFirstPayment = \{\s*\$and: \[\s*\{ \$eq: \[\{ \$ifNull: \["\$paidAt", null\] \}, null\] \},\s*\{ \$ne: \["\$status", "PAID"\] \},/,
      "the guard is keyed on paidAt and excludes legacy PAID"
    );
  });

  test("account and snapshot are guarded by paidAt, never by a null account id", () => {
    assert.ok(
      !pay.includes('{ $ifNull: ["$paymentAccountId", null] }'),
      "the account id must not be the first-payment marker"
    );
    assert.ok(pay.includes('$cond: [isFirstPayment, firstPayment.paymentAccountId, "$paymentAccountId"]'));
    assert.ok(
      pay.includes('$cond: [isFirstPayment, firstPayment.paymentAccountSnapshot, "$paymentAccountSnapshot"]')
    );
    // Cash first payment clears the account; a cash retry after transfer
    // preserves the stored transfer identity.
    assert.ok(pay.includes('$cond: [isFirstPayment, null, "$paymentAccountId"]'));
    assert.ok(pay.includes('$cond: [isFirstPayment, null, "$paymentAccountSnapshot"]'));
  });

  test("paidAt, completedAt and servedAt are stamped only on a genuine first settlement", () => {
    assert.ok(pay.includes('$cond: [isFirstPayment, now, "$paidAt"]'));
    for (const field of ["completedAt", "servedAt"]) {
      assert.match(
        pay,
        new RegExp(
          `\\$and: \\[isFirstPayment, \\{ \\$eq: \\[\\{ \\$ifNull: \\["\\$${field}", null\\] \\}, null\\] \\}\\]`
        ),
        `${field} must only be filled on a first settlement and never overwritten`
      );
    }
  });

  test("a different-method retry is logged without account or secret data", () => {
    assert.ok(pay.includes('"payment_method_preserved"'));
    assert.ok(pay.includes("requestedMethod: pm"));
    assert.ok(pay.includes("storedMethod: doc.paymentMethod"));
    assert.ok(pay.includes('result: "PRESERVED"'));
    const logBlock = sliceBetween(pay, "payment_method_preserved", "await applyPaidInventory");
    assert.doesNotMatch(logBlock, /accountNumber|bankName|ownerName|paymentAccountSnapshot|paymentAccountId|pin/i);
  });

  test("payment leaves unrelated financial history untouched", () => {
    for (const field of [
      "paymentSubmittedAt",
      "paymentSubmittedBy",
      "paymentVerifiedAt",
      "paymentVerifiedBy",
      "paymentRejectedAt",
      "paymentRejectedBy",
      "paymentRejectionReason",
      "refund",
      "chargeback",
      "tax",
    ]) {
      assert.ok(!pay.includes(field), `payOrder must not touch ${field}`);
    }
  });
});

describe("Phase 2.5 WP-01 — updatePayment freeze", () => {
  test("the PAID timestamp-stamping block is gone", () => {
    assert.doesNotMatch(update, /if\s*\(\s*order\.status\s*===\s*["']PAID["']\s*\)/);
    assert.ok(!update.includes("extra.paidAt"));
    assert.ok(!update.includes("extra.completedAt"));
    assert.ok(!update.includes("extra.servedAt"));
    assert.doesNotMatch(update, /\bcompletedAt\s*:/);
    assert.doesNotMatch(update, /\bservedAt\s*:/);
    assert.ok(!update.includes("paidAt: new Date()"));
    assert.ok(!update.includes("extra.paidAt"));
  });

  test("PAID and legacy-paid orders are frozen by the shared decision", () => {
    assert.ok(update.includes("isFrozenPaymentIdentity(existing)"));
    assert.ok(update.includes("paymentMethodsEquivalent(requestedMethod, existing.paymentMethod)"));
    assert.ok(update.includes("throw paymentMethodImmutableError()"));
    assert.ok(update.includes('"payment_method_conflict"'));
    assert.ok(update.includes("storedMethod: existing.paymentMethod || null"));
  });

  test("the pre-PAID write is atomic and re-checks the freeze marker", () => {
    assert.ok(update.includes("await Order.findOneAndUpdate("));
    assert.ok(update.includes("paidAt: null"));
    assert.ok(update.includes('status: { $ne: "PAID" }'));
    assert.ok(!update.includes("updateOrderFields("), "the unguarded helper must not be used");
    assert.ok(
      update.indexOf("paidAt: null") < update.indexOf("returnDocument: \"after\""),
      "the guard must be part of the write filter"
    );
  });

  test("a concurrent freeze is resolved by re-read, not a blind retry", () => {
    assert.ok(update.includes("const after = await Order.findOne("));
    assert.ok(update.includes("paymentMethodsEquivalent(requestedMethod, after.paymentMethod)"));
    assert.ok(!/catch\s*\(/.test(update), "database/topology errors must propagate cleanly");
    assert.ok(!/for\s*\(/.test(update) && !/while\s*\(/.test(update), "no unbounded retry loop");
  });
});

describe("Phase 2.5 WP-01 — error mapping and unchanged payment flows", () => {
  test("both order routes map a status-bearing service error to 409 + code", () => {
    for (const route of [orderRoute, statusRoute]) {
      assert.ok(route.includes("Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599"));
      assert.ok(route.includes("return fail(msg, err.status, err.code)"));
    }
    assert.ok(orderRoute.includes("actorId: auth.payload.staffId"));
  });

  test("submitPaymentForVerification cannot run on PAID and preserves the submitted identity", () => {
    assert.ok(submit.includes('status: "SERVED"'));
    assert.ok(submit.includes('if (existing.status === "PAID") throw new Error("Order already paid")'));
    assert.ok(submit.includes("paymentMethod: pm"));
  });

  test("confirmPayment preserves the submitted method/account snapshot", () => {
    assert.ok(confirm.includes('status: "PAYMENT_PENDING"'));
    assert.ok(!confirm.includes("paymentMethod:"), "confirm must not rewrite the submitted method");
    assert.ok(!confirm.includes("paymentAccountId:"), "confirm must not rewrite the submitted account");
    assert.ok(!confirm.includes("paymentAccountSnapshot:"), "confirm must not rewrite the snapshot");
  });

  test("rejectPayment returns to SERVED without touching the identity", () => {
    assert.ok(reject.includes('status: "PAYMENT_PENDING"'));
    assert.ok(reject.includes('status: "SERVED"'));
    assert.ok(!reject.includes("paymentMethod:"));
    assert.ok(!reject.includes("paymentAccountId:"));
    assert.ok(!reject.includes("paymentAccountSnapshot:"));
    assert.ok(!reject.includes("paidAt:"));
  });

  test("no refund, chargeback, or accounting rule is invented", () => {
    const codeOnly = [pay, update, submit, confirm, reject].join("\n");
    assert.doesNotMatch(codeOnly, /\brefund|chargeback|creditNote|journalEntry|debitAccount|creditAccount/i);
  });
});
