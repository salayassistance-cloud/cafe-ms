// Offline tests for the V1 requirement-conversion boundary.
//
// Covers lib/inventoryRequirementConversion.js directly (pure, DB-free) plus
// static source contracts for the single integration point in
// lib/inventoryReservationService.js#validateRequirements().
//
// No database, no Mongoose, no environment access.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  convertRequirementToStockUnit,
  mergeRequirements,
} from "../lib/inventoryRequirementConversion.js";
import { buildRequirementFingerprint } from "../lib/inventoryReservationRules.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const A = "64b000000000000000000001";
const B = "64b000000000000000000002";

function row(inventoryItemId, unit, requiredQuantity, extra = {}) {
  return { inventoryItemId, unit, requiredQuantity, ...extra };
}

describe("exact conversion into the stock unit", () => {
  test("kg → g converts exactly", () => {
    const res = convertRequirementToStockUnit(1.5, "kg", "g");
    assert.equal(res.ok, true);
    assert.equal(res.quantity, 1500);
    assert.equal(res.quantityMilli, 1500000n);
    assert.equal(res.code, null);
  });

  test("g → kg converts exactly", () => {
    const res = convertRequirementToStockUnit(1500, "g", "kg");
    assert.equal(res.ok, true);
    assert.equal(res.quantity, 1.5);
    assert.equal(res.quantityMilli, 1500n);
  });

  test("ml ↔ L converts exactly in both directions", () => {
    const toMl = convertRequirementToStockUnit(1.25, "L", "ml");
    assert.equal(toMl.ok, true);
    assert.equal(toMl.quantity, 1250);

    const toL = convertRequirementToStockUnit(1250, "ml", "L");
    assert.equal(toL.ok, true);
    assert.equal(toL.quantity, 1.25);
  });

  test("alias spellings are accepted by the canonical vocabulary", () => {
    const res = convertRequirementToStockUnit(1, "Kilograms", "grams");
    assert.equal(res.ok, true);
    assert.equal(res.quantity, 1000);
  });

  test("the smallest exact three-decimal boundary is accepted", () => {
    // 0.0015 kg is exactly 1.5 g, which V1 can represent.
    const res = convertRequirementToStockUnit(0.0015, "kg", "g");
    assert.equal(res.ok, true);
    assert.equal(res.quantity, 1.5);
  });

  test("same-unit conversion is an exact no-op", () => {
    const res = convertRequirementToStockUnit(2.5, "kg", "kg");
    assert.equal(res.ok, true);
    assert.equal(res.quantity, 2.5);
    assert.equal(res.quantityMilli, 2500n);
  });
});

describe("fail-closed conversion", () => {
  test("0.5 g → kg is rejected, never rounded", () => {
    const res = convertRequirementToStockUnit(0.5, "g", "kg");
    assert.equal(res.ok, false);
    assert.equal(res.code, "LOSSY_CONVERSION");
    assert.equal(res.quantity, null);
    // 0.0005 kg would need four decimals; rounding to 0.001 would be 2× wrong.
    assert.notEqual(res.quantity, 0.001);
  });

  test("1.5 g → kg is rejected as lossy", () => {
    const res = convertRequirementToStockUnit(1.5, "g", "kg");
    assert.equal(res.ok, false);
    assert.equal(res.code, "LOSSY_CONVERSION");
  });

  test("unknown unit oz fails closed", () => {
    const res = convertRequirementToStockUnit(1, "oz", "g");
    assert.equal(res.ok, false);
    assert.equal(res.code, "UNKNOWN_UNIT");
  });

  test("ambiguous unit cup fails closed", () => {
    const res = convertRequirementToStockUnit(1, "cup", "ml");
    assert.equal(res.ok, false);
    assert.equal(res.code, "AMBIGUOUS_UNIT");
  });

  test("bottle and can are never inferred as pcs", () => {
    for (const unit of ["bottle", "can", "bottles", "cans"]) {
      const res = convertRequirementToStockUnit(1, unit, "pcs");
      assert.equal(res.ok, false, `${unit} must not convert to pcs`);
      assert.equal(res.code, "AMBIGUOUS_UNIT");
    }
  });

  test("pcs → bottle fails closed at the target unit", () => {
    const res = convertRequirementToStockUnit(1, "pcs", "bottle");
    assert.equal(res.ok, false);
    assert.equal(res.code, "AMBIGUOUS_UNIT");
  });

  test("missing stock unit fails closed", () => {
    for (const stockUnit of ["", "   ", null, undefined]) {
      const res = convertRequirementToStockUnit(1, "kg", stockUnit);
      assert.equal(res.ok, false, `stock unit ${JSON.stringify(stockUnit)} must fail`);
      assert.equal(res.code, "MISSING_UNIT");
    }
  });

  test("missing demand unit fails closed", () => {
    const res = convertRequirementToStockUnit(1, "", "g");
    assert.equal(res.ok, false);
    assert.equal(res.code, "MISSING_UNIT");
  });

  test("cross-dimension conversions fail closed", () => {
    for (const [demand, stock] of [
      ["g", "ml"],
      ["ml", "g"],
      ["pcs", "g"],
      ["g", "pcs"],
    ]) {
      const res = convertRequirementToStockUnit(1, demand, stock);
      assert.equal(res.ok, false, `${demand} → ${stock} must fail`);
      assert.equal(res.code, "UNIT_DIMENSION_MISMATCH");
    }
  });

  test("out-of-range quantities fail closed", () => {
    const res = convertRequirementToStockUnit(1e9, "kg", "g");
    assert.equal(res.ok, false);
    assert.equal(res.code, "QUANTITY_OUT_OF_RANGE");
  });

  test("invalid and negative quantities fail closed", () => {
    const invalid = convertRequirementToStockUnit("abc", "g", "kg");
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "INVALID_QUANTITY");

    const nan = convertRequirementToStockUnit(Number.NaN, "g", "kg");
    assert.equal(nan.ok, false);
    assert.equal(nan.code, "INVALID_QUANTITY");

    const negative = convertRequirementToStockUnit(-5, "g", "kg");
    assert.equal(negative.ok, false);
    assert.equal(negative.code, "NEGATIVE_QUANTITY");
  });

  test("quantities with more precision than the engine supports fail closed", () => {
    const res = convertRequirementToStockUnit(0.0000001, "g", "kg");
    assert.equal(res.ok, false);
    assert.equal(res.code, "QUANTITY_PRECISION_UNSUPPORTED");
  });
});

describe("deterministic requirement merging", () => {
  test("duplicate same-item rows merge into one requirement", () => {
    const out = mergeRequirements([row(A, "kg", 1.5), row(A, "kg", 2.5)]);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].inventoryItemId, A);
    assert.equal(out.items[0].unit, "kg");
    assert.equal(out.items[0].requiredQuantity, 4);
  });

  test("merge output is independent of input order", () => {
    const forward = mergeRequirements([
      row(A, "kg", 1.5),
      row(A, "kg", 2.5),
      row(B, "g", 10),
    ]);
    const reversed = mergeRequirements([
      row(B, "g", 10),
      row(A, "kg", 2.5),
      row(A, "kg", 1.5),
    ]);
    assert.deepEqual(reversed.items, forward.items);
    assert.deepEqual(reversed.warnings, forward.warnings);
  });

  test("case and whitespace same-unit variants merge deterministically", () => {
    const rows = [row(A, "kg", 1), row(A, "KG", 1.5), row(A, " kg ", 0.5)];
    const forward = mergeRequirements(rows);
    const reversed = mergeRequirements([...rows].reverse());

    assert.equal(forward.warnings.length, 0);
    assert.equal(forward.items.length, 1);
    assert.equal(forward.items[0].requiredQuantity, 3);
    assert.deepEqual(reversed.items, forward.items);
    assert.deepEqual(reversed.warnings, forward.warnings);
  });

  test("incompatible dimensions are never merged", () => {
    const out = mergeRequirements([row(A, "g", 100), row(A, "ml", 50)]);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.items.length, 2);
    assert.deepEqual(
      out.items.map((it) => it.unit),
      ["g", "ml"]
    );
  });

  test("bottle/bottle same-unit rows are rejected as ambiguous", () => {
    const out = mergeRequirements([
      row(A, "bottle", 1),
      row(A, "bottle", 2),
    ]);
    assert.equal(out.items.length, 0);
    assert.ok(out.warnings.length > 0);
    for (const warning of out.warnings) assert.match(warning, /AMBIGUOUS_UNIT/);
  });

  test("cup/cup same-unit rows are rejected as ambiguous", () => {
    const out = mergeRequirements([
      row(A, "cup", 1),
      row(A, "CUP", 2),
    ]);
    assert.equal(out.items.length, 0);
    assert.ok(out.warnings.length > 0);
    for (const warning of out.warnings) assert.match(warning, /AMBIGUOUS_UNIT/);
  });

  test("milli-unit sums are exact; no floating-point drift", () => {
    const out = mergeRequirements([row(A, "kg", 0.1), row(A, "kg", 0.2)]);
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].requiredQuantity, 0.3);
    assert.notEqual(out.items[0].requiredQuantity, 0.1 + 0.2);
  });

  test("a single same-unit row round-trips unchanged", () => {
    const out = mergeRequirements([row(B, "g", 12.345)]);
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].unit, "g");
    assert.equal(out.items[0].requiredQuantity, 12.345);
  });

  test("required item fields and extra fields are preserved", () => {
    const out = mergeRequirements([row(A, "kg", 2, { note: "kept" })]);
    assert.deepEqual(out.items[0], {
      inventoryItemId: A,
      unit: "kg",
      requiredQuantity: 2,
      note: "kept",
    });
  });

  test("merged output is sorted deterministically", () => {
    const out = mergeRequirements([row(B, "g", 1), row(A, "kg", 1)]);
    assert.deepEqual(
      out.items.map((it) => it.inventoryItemId),
      [A, B]
    );
  });

  test("invalid merge rows fail closed with a warning", () => {
    const zero = mergeRequirements([row(A, "g", 0)]);
    assert.equal(zero.items.length, 0);
    assert.equal(zero.warnings.length, 1);
    assert.ok(zero.warnings[0].includes("INVALID_QUANTITY"));

    const nan = mergeRequirements([row(A, "g", Number.NaN)]);
    assert.equal(nan.items.length, 0);
    assert.ok(nan.warnings[0].includes("INVALID_QUANTITY"));

    const negative = mergeRequirements([row(A, "g", -1)]);
    assert.equal(negative.items.length, 0);
    assert.ok(negative.warnings[0].includes("NEGATIVE_QUANTITY"));

    const missingId = mergeRequirements([row("", "g", 1)]);
    assert.equal(missingId.items.length, 0);
    assert.ok(missingId.warnings[0].includes("INVALID_QUANTITY"));
  });

  test("a merge row that needs more than three decimals is rejected, never rounded", () => {
    const out = mergeRequirements([row(A, "g", 0.0005)]);
    assert.equal(out.items.length, 0);
    assert.equal(out.warnings.length, 1);
    assert.ok(out.warnings[0].includes("QUANTITY_PRECISION_UNSUPPORTED"));
  });
});

describe("integration source contracts", () => {
  const service = src("lib/inventoryReservationService.js");
  const validateStart = service.indexOf("async function validateRequirements");
  const validateEnd = service.indexOf("function itemsFromReservation", validateStart);
  const validate = service.slice(validateStart, validateEnd);

  test("validateRequirements is present and imported from the approved helper", () => {
    assert.ok(validateStart > 0, "validateRequirements must exist");
    assert.ok(validateEnd > validateStart, "validateRequirements must be bounded");
    assert.ok(service.includes('from "@/lib/inventoryRequirementConversion"'));
    assert.ok(validate.includes("convertRequirementToStockUnit("));
    assert.ok(validate.includes("mergeRequirements(items)"));
  });

  test("sameUnit fast path precedes conversion", () => {
    const fastPath = validate.indexOf("sameUnit(invUnit, req.unit)");
    const conversion = validate.indexOf("convertRequirementToStockUnit(");
    assert.ok(fastPath > 0, "sameUnit fast path must remain first");
    assert.ok(conversion > fastPath, "conversion must run only after the fast path");
  });

  test("conversion happens before any round3 in the mismatch branch", () => {
    const conversion = validate.indexOf("convertRequirementToStockUnit(");
    const round = validate.indexOf("round3(");
    assert.ok(round > conversion, "converted quantities must never be round3'd");
  });

  test("converted rows carry the stock unit and the exact converted quantity", () => {
    assert.ok(validate.includes("unit: invUnit,"));
    assert.ok(validate.includes("requiredQuantity: conversion.quantity,"));
    assert.ok(validate.includes("if (!conversion.ok)"));
    assert.ok(validate.includes("conversion.code"));
  });

  test("the existing return shape is preserved with merged items and unresolved detail", () => {
    assert.ok(validate.includes("return { items: merged.items, inventory, warnings, unresolved }"));
  });

  test("reconciliation writes shortage state and discards legacy approval", () => {
    assert.ok(service.includes('nextStatus = "INSUFFICIENT_STOCK"'));
    assert.ok(service.includes("const shortage = finalItems.some"));
    assert.ok(service.includes("approval: null"));
    assert.equal(service.includes('nextStatus = "APPROVAL_REQUIRED"'), false);
    assert.equal(service.includes('"APPROVAL_STALE"'), false);
  });
});

describe("focused requirement-shape regression (no database)", () => {
  test("a changed requirement shape produces a different fingerprint", () => {
    const duplicateRows = [
      row(A, "kg", 1),
      row(A, "KG", 2),
    ];
    const oldFp = buildRequirementFingerprint("order-1", duplicateRows);

    const merged = mergeRequirements([row(A, "kg", 3)]);
    assert.equal(merged.warnings.length, 0);
    const newFp = buildRequirementFingerprint("order-1", merged.items);

    assert.notEqual(oldFp, newFp, "a changed requirement shape must invalidate the snapshot");
  });

  test("an unchanged merged requirement keeps its fingerprint", () => {
    const first = buildRequirementFingerprint(
      "order-1",
      mergeRequirements([row(A, "kg", 1), row(A, "kg", 2)]).items
    );
    const replay = buildRequirementFingerprint(
      "order-1",
      mergeRequirements([row(A, "kg", 3)]).items
    );
    assert.equal(first, replay, "a replay of the same requirements must stay valid");
  });
});

describe("helper isolation", () => {
  const helper = src("lib/inventoryRequirementConversion.js");

  test("helper has no database, Mongoose, environment, or app-runtime import", () => {
    assert.equal(/mongoose\./.test(helper), false);
    assert.equal(/process\.env/.test(helper), false);
    assert.equal(/@\/lib\//.test(helper), false);
    assert.equal(/require\s*\(/.test(helper), false);

    const specifiers = [...helper.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1]
    );
    for (const specifier of specifiers) {
      assert.equal(
        /mongoose|mongodb|proces|next\//i.test(specifier),
        false,
        `forbidden import: ${specifier}`
      );
    }
  });

  test("helper uses relative imports only", () => {
    const specifiers = [...helper.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1]
    );
    assert.ok(specifiers.length >= 2);
    assert.ok(
      specifiers.every((specifier) => specifier.startsWith("./")),
      `unexpected import specifier: ${specifiers.join(", ")}`
    );
  });

  test("helper performs no side effects at import time", () => {
    assert.equal(/console\./.test(helper), false);
    assert.equal(/process\.(?!env)/.test(helper), false);
    assert.equal(/globalThis\./.test(helper), false);
    assert.equal(/^\s*await\s/m.test(helper), false);
  });
});
