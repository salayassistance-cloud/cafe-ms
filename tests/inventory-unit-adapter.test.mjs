// BONO Inventory — Phase 2, Step 3: V1 → canonical unit adapter tests.
//
// DB-free. These tests only import the pure adapter and the pure unit module;
// no MongoDB connection, environment file, or application service is loaded.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, test } from "node:test";

import {
  ADAPTER_ERROR_CODES,
  AMBIGUOUS_UNITS,
  adaptV1Quantity,
  canAdaptV1Quantity,
  convertAdaptedQuantity,
  formatCanonicalQuantity,
  formatInUnit,
  toSourceUnitQuantity,
} from "../lib/inventoryUnitAdapter.js";
import {
  InventoryUnitError,
  MAX_SCALED_QUANTITY,
  UNIT_ERROR_CODES,
  normalizeUnit,
} from "../lib/inventoryUnits.js";

const ADAPTER_SOURCE = readFileSync(
  new URL("../lib/inventoryUnitAdapter.js", import.meta.url),
  "utf8"
);

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(
      error instanceof InventoryUnitError,
      `expected InventoryUnitError, got ${error && error.name}`
    );
    assert.equal(error.code, code);
    return true;
  });
}

describe("canonical unit passthrough", () => {
  test("g, ml and pcs adapt to themselves without scaling", () => {
    const cases = [
      { quantity: 250, unit: "g", dimension: "MASS", canonicalUnit: "g" },
      { quantity: 750, unit: "ml", dimension: "VOLUME", canonicalUnit: "ml" },
      { quantity: 3, unit: "pcs", dimension: "COUNT", canonicalUnit: "pcs" },
    ];

    for (const { quantity, unit, dimension, canonicalUnit } of cases) {
      const adapted = adaptV1Quantity(quantity, unit);
      assert.equal(adapted.dimension, dimension);
      assert.equal(adapted.canonicalUnit, canonicalUnit);
      assert.equal(adapted.approvedUnit, canonicalUnit);
      assert.equal(adapted.scaled, BigInt(quantity) * 1_000_000n);
      assert.equal(adapted.value, String(quantity));
      assert.equal(adapted.sourceQuantity, quantity);
      assert.equal(adapted.sourceUnit, unit);
    }
  });

  test("a unit label is never converted on its own", () => {
    const kilogram = adaptV1Quantity(1, "kg");
    const gram = adaptV1Quantity(1, "g");

    // Same canonical unit, different quantities: 1 kg is 1000 g, not 1 g.
    assert.equal(kilogram.canonicalUnit, "g");
    assert.equal(gram.canonicalUnit, "g");
    assert.equal(kilogram.scaled, 1_000_000_000n);
    assert.equal(gram.scaled, 1_000_000n);
    assert.notEqual(kilogram.scaled, gram.scaled);
    assert.equal(kilogram.value, "1000");
    assert.equal(gram.value, "1");
  });
});

describe("mass and volume equivalence", () => {
  test("kg and g agree exactly for the same physical quantity", () => {
    for (const [kgValue, gValue] of [
      [1, 1000],
      [0.5, 500],
      ["1.2345", "1234.5"],
      ["0.000001", "0.001"],
      [2, 2000],
    ]) {
      const fromKg = adaptV1Quantity(kgValue, "kg");
      const fromG = adaptV1Quantity(gValue, "g");

      assert.equal(fromKg.dimension, "MASS");
      assert.equal(fromKg.canonicalUnit, "g");
      assert.equal(fromKg.scaled, fromG.scaled, `${kgValue} kg vs ${gValue} g`);
      assert.equal(fromKg.value, fromG.value);
    }
  });

  test("L and ml agree exactly for the same physical quantity", () => {
    for (const [litreValue, mlValue] of [
      [1, 1000],
      [0.75, 750],
      ["0.0005", "0.5"],
      ["1.2345", "1234.5"],
    ]) {
      const fromLitre = adaptV1Quantity(litreValue, "L");
      const fromMl = adaptV1Quantity(mlValue, "ml");

      assert.equal(fromLitre.dimension, "VOLUME");
      assert.equal(fromLitre.canonicalUnit, "ml");
      assert.equal(fromLitre.scaled, fromMl.scaled);
      assert.equal(fromLitre.value, fromMl.value);
    }
  });

  test("supported legacy aliases normalize while preserving their original text", () => {
    for (const [alias, expectedScaled, expectedApproved] of [
      ["kilograms", 1_000_000_000n, "kg"],
      ["KGS", 1_000_000_000n, "kg"],
      ["gram", 1_000_000n, "g"],
      ["litres", 1_000_000_000n, "L"],
      ["liter", 1_000_000_000n, "L"],
      ["each", 1_000_000n, "pcs"],
      [" Piece ", 1_000_000n, "pcs"],
    ]) {
      const adapted = adaptV1Quantity(1, alias);
      assert.equal(adapted.scaled, expectedScaled, alias);
      assert.equal(adapted.approvedUnit, expectedApproved, alias);
      assert.equal(adapted.sourceUnit, alias);
    }
  });

  test("case and whitespace variants adapt identically to the canonical label", () => {
    const variants = ["kg", "KG", " Kg ", "kilograms"];
    const baseline = adaptV1Quantity(2, "kg");

    for (const unit of variants) {
      const adapted = adaptV1Quantity(2, unit);
      assert.equal(adapted.scaled, baseline.scaled, unit);
      assert.equal(adapted.canonicalUnit, "g");
      assert.equal(adapted.approvedUnit, "kg");
      assert.equal(adapted.sourceUnit, unit);
    }
  });
});

describe("rejection of unsupported and ambiguous units", () => {
  test("unsupported legacy aliases are rejected, never guessed", () => {
    for (const unit of [
      "oz",
      "ounce",
      "lb",
      "lbs",
      "gm",
      "tbsp",
      "tsp",
      "dozen",
      "ml.",
      "kg/",
      "k g",
    ]) {
      assert.equal(canAdaptV1Quantity(1, unit), false, unit);
      throwsCode(
        () => adaptV1Quantity(1, unit),
        UNIT_ERROR_CODES.UNKNOWN_UNIT
      );
    }
  });

  test("every ambiguous container/portion unit is rejected as AMBIGUOUS_UNIT", () => {
    assert.ok(AMBIGUOUS_UNITS.includes("bottle"));
    assert.ok(AMBIGUOUS_UNITS.includes("can"));
    assert.ok(AMBIGUOUS_UNITS.includes("pack"));
    assert.ok(AMBIGUOUS_UNITS.includes("unit"));

    for (const unit of AMBIGUOUS_UNITS) {
      assert.equal(canAdaptV1Quantity(1, unit), false, unit);
      throwsCode(
        () => adaptV1Quantity(1, unit),
        ADAPTER_ERROR_CODES.AMBIGUOUS_UNIT
      );
    }
  });

  test("bottle and can are not inferred as pcs despite the alias table", () => {
    // The canonical vocabulary accepts these; the adapter deliberately refuses
    // them because Step 2 found no evidence establishing their dimension.
    assert.equal(normalizeUnit("bottle").unit, "pcs");
    assert.equal(normalizeUnit("can").unit, "pcs");

    for (const unit of ["bottle", "bottles", "can", "cans"]) {
      throwsCode(
        () => adaptV1Quantity(1, unit),
        ADAPTER_ERROR_CODES.AMBIGUOUS_UNIT
      );
    }
  });

  test("null, undefined, empty and whitespace-only units are rejected", () => {
    for (const unit of [null, undefined, "", "   ", "\t", "\n"]) {
      throwsCode(
        () => adaptV1Quantity(1, unit),
        ADAPTER_ERROR_CODES.MISSING_UNIT
      );
    }
  });

  test("non-string units fail closed through the canonical vocabulary", () => {
    for (const unit of [1, true, {}, [], Symbol("kg")]) {
      assert.equal(canAdaptV1Quantity(1, unit), false);
      throwsCode(
        () => adaptV1Quantity(1, unit),
        UNIT_ERROR_CODES.UNKNOWN_UNIT
      );
    }
  });

  test("ambiguous targets are rejected by conversion and formatting helpers", () => {
    const adapted = adaptV1Quantity(1, "kg");
    throwsCode(
      () => convertAdaptedQuantity(adapted, "bottle"),
      ADAPTER_ERROR_CODES.AMBIGUOUS_UNIT
    );
    throwsCode(
      () => formatInUnit(adapted.scaled, "box"),
      ADAPTER_ERROR_CODES.AMBIGUOUS_UNIT
    );
  });
});

describe("quantity boundaries", () => {
  test("negative quantities are rejected for every dimension", () => {
    for (const [quantity, unit] of [
      [-1, "kg"],
      ["-0.5", "g"],
      [-2, "pcs"],
      ["-1", "L"],
    ]) {
      throwsCode(
        () => adaptV1Quantity(quantity, unit),
        UNIT_ERROR_CODES.NEGATIVE_QUANTITY
      );
    }
  });

  test("negative zero normalizes to an exact zero", () => {
    const adapted = adaptV1Quantity("-0", "pcs");
    assert.equal(adapted.scaled, 0n);
    assert.equal(adapted.value, "0");
    assert.equal(adapted.sourceQuantity, "-0");
  });

  test("precision is exact at the boundary and rejected one digit beyond", () => {
    // g/ml allow 1e-6; kg/L allow 1e-9 (which is 1e-6 g/ml).
    assert.equal(adaptV1Quantity("0.000001", "g").scaled, 1n);
    assert.equal(adaptV1Quantity("0.000001", "ml").scaled, 1n);
    assert.equal(adaptV1Quantity("0.000000001", "kg").scaled, 1n);
    assert.equal(adaptV1Quantity("0.000000001", "L").scaled, 1n);

    throwsCode(
      () => adaptV1Quantity("0.0000001", "g"),
      UNIT_ERROR_CODES.QUANTITY_PRECISION_UNSUPPORTED
    );
    throwsCode(
      () => adaptV1Quantity("0.0000000001", "kg"),
      UNIT_ERROR_CODES.QUANTITY_PRECISION_UNSUPPORTED
    );
  });

  test("the maximum exact bound is inclusive and the next value is rejected", () => {
    assert.equal(MAX_SCALED_QUANTITY, 100_000_000_000_000n);
    assert.equal(
      adaptV1Quantity("100000000", "g").scaled,
      MAX_SCALED_QUANTITY
    );
    assert.equal(
      adaptV1Quantity("100000", "kg").scaled,
      MAX_SCALED_QUANTITY
    );

    throwsCode(
      () => adaptV1Quantity("100000000.000001", "g"),
      UNIT_ERROR_CODES.QUANTITY_OUT_OF_RANGE
    );
    throwsCode(
      () => adaptV1Quantity("100000.0000001", "kg"),
      UNIT_ERROR_CODES.QUANTITY_OUT_OF_RANGE
    );
  });

  test("non-finite and malformed quantities are rejected", () => {
    for (const quantity of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "",
      "abc",
      "1,5",
      null,
      undefined,
      {},
      [],
      true,
    ]) {
      assert.equal(canAdaptV1Quantity(quantity, "kg"), false, String(quantity));
    }
  });
});

describe("original value preservation", () => {
  test("the original quantity and unit are returned unchanged", () => {
    const numeric = adaptV1Quantity(0.5, " kg ");
    assert.equal(numeric.sourceQuantity, 0.5);
    assert.ok(Object.is(numeric.sourceQuantity, 0.5));
    assert.equal(numeric.sourceUnit, " kg ");
    assert.equal(numeric.approvedUnit, "kg");
    assert.equal(numeric.scaled, 500_000_000n);

    const textual = adaptV1Quantity("2.5", "KG");
    assert.equal(textual.sourceQuantity, "2.5");
    assert.equal(textual.sourceUnit, "KG");
    assert.equal(textual.value, "2500");
  });

  test("adapted results are frozen and expose both BigInt and string scaling", () => {
    const adapted = adaptV1Quantity(1.5, "kg");

    assert.ok(Object.isFrozen(adapted));
    assert.equal(typeof adapted.scaled, "bigint");
    assert.equal(adapted.scaledString, "1500000000");
    assert.equal(adapted.scaled.toString(), adapted.scaledString);
    assert.equal(adapted.factorNumerator, 1000n);
    assert.equal(adapted.factorDenominator, 1n);
  });
});

describe("exact reverse and display", () => {
  test("adapter-produced values round-trip through the original unit exactly", () => {
    const cases = [
      [1, "kg"],
      [0.5, "kg"],
      ["1.2345", "kg"],
      ["0.000001", "kg"],
      [250, "g"],
      ["0.000001", "g"],
      [1, "L"],
      [0.75, "L"],
      ["0.0005", "L"],
      [500, "ml"],
      [3, "pcs"],
      ["0", "pcs"],
    ];

    for (const [quantity, unit] of cases) {
      const adapted = adaptV1Quantity(quantity, unit);
      const reversed = toSourceUnitQuantity(adapted);

      assert.equal(reversed.unit, adapted.approvedUnit);
      assert.equal(reversed.canonicalUnit, adapted.canonicalUnit);
      assert.equal(reversed.scaled, adapted.scaled);
      assert.equal(reversed.sourceQuantity, adapted.sourceQuantity);
      assert.equal(reversed.sourceUnit, adapted.sourceUnit);

      const reAdapted = adaptV1Quantity(reversed.value, reversed.unit);
      assert.equal(
        reAdapted.scaled,
        adapted.scaled,
        `${quantity} ${unit} -> ${reversed.value} ${reversed.unit}`
      );
    }
  });

  test("display values are exact decimal strings, never approximations", () => {
    assert.equal(toSourceUnitQuantity(adaptV1Quantity(1, "kg")).value, "1");
    assert.equal(toSourceUnitQuantity(adaptV1Quantity(250, "g")).value, "250");
    assert.equal(toSourceUnitQuantity(adaptV1Quantity(1, "L")).value, "1");
    assert.equal(toSourceUnitQuantity(adaptV1Quantity(500, "ml")).value, "500");
    assert.equal(toSourceUnitQuantity(adaptV1Quantity(3, "pcs")).value, "3");

    // Displaying the same quantity in a larger unit is also exact.
    assert.equal(
      convertAdaptedQuantity(adaptV1Quantity(250, "g"), "kg").value,
      "0.25"
    );
    assert.equal(
      convertAdaptedQuantity(adaptV1Quantity(500, "ml"), "L").value,
      "0.5"
    );

    assert.equal(formatCanonicalQuantity(1n), "0.000001");
    assert.equal(formatCanonicalQuantity(1_234_500_000n), "1234.5");
  });

  test("a value that cannot be represented exactly is rejected, not rounded", () => {
    const adapted = adaptV1Quantity(1, "kg");

    // Tampered decimal text with more precision than the canonical contract.
    throwsCode(
      () => toSourceUnitQuantity({ ...adapted, value: "0.0000001" }),
      ADAPTER_ERROR_CODES.LOSSY_CONVERSION
    );

    // Inconsistent scaled/value pair: the round-trip check must catch it.
    throwsCode(
      () => toSourceUnitQuantity({ ...adapted, scaled: 999n, value: "1" }),
      ADAPTER_ERROR_CODES.LOSSY_CONVERSION
    );
  });

  test("cross-dimension conversions are rejected in both directions", () => {
    for (const [quantity, unit, target] of [
      [1, "kg", "ml"],
      [1, "g", "L"],
      [1, "pcs", "g"],
      [1, "ml", "kg"],
    ]) {
      throwsCode(
        () => convertAdaptedQuantity(adaptV1Quantity(quantity, unit), target),
        UNIT_ERROR_CODES.UNIT_DIMENSION_MISMATCH
      );
    }
  });

  test("same-dimension conversion is exact and preserves the originals", () => {
    const adapted = adaptV1Quantity(1.5, "kg");
    const grams = convertAdaptedQuantity(adapted, "g");
    assert.equal(grams.unit, "g");
    assert.equal(grams.value, "1500");
    assert.equal(grams.scaled, adapted.scaled);
    assert.equal(grams.sourceQuantity, 1.5);
    assert.equal(grams.sourceUnit, "kg");

    const litres = convertAdaptedQuantity(adaptV1Quantity(750, "ml"), "litre");
    assert.equal(litres.unit, "L");
    assert.equal(litres.value, "0.75");
    assert.equal(litres.scaled, 750_000_000n);
  });

  test("scaled formatting validates type, sign and bound", () => {
    throwsCode(
      () => formatCanonicalQuantity(1),
      UNIT_ERROR_CODES.INVALID_QUANTITY
    );
    throwsCode(
      () => formatCanonicalQuantity(-1n),
      UNIT_ERROR_CODES.NEGATIVE_QUANTITY
    );
    throwsCode(
      () => formatCanonicalQuantity(MAX_SCALED_QUANTITY + 1n),
      UNIT_ERROR_CODES.QUANTITY_OUT_OF_RANGE
    );
  });
});

describe("isolation", () => {
  test("the adapter imports only the pure unit module", () => {
    const specifiers = [...ADAPTER_SOURCE.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1]
    );
    assert.deepEqual(specifiers, ["./inventoryUnits.js"]);
    assert.ok(!/\brequire\s*\(/.test(ADAPTER_SOURCE));
    assert.ok(!/\bfrom\s+["'](?:@\/|\.\.\/|\.\.\/\.\.\/)/.test(ADAPTER_SOURCE));
  });

  test("no runtime module imports the adapter", () => {
    const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const runtimeDirs = ["lib", "app", "scripts"];
    // The adapter is intentionally wired only at the approved V1 requirement
    // conversion boundary (owner-approved, 2026-11-15). Under lib/, every other
    // module remains forbidden.
    const allowedLibImporters = new Set([
      "inventoryUnitAdapter.js",
      "inventoryRequirementConversion.js",
    ]);
    const offenders = [];

    for (const dir of runtimeDirs) {
      for (const relative of readdirSync(join(root, dir), { recursive: true })) {
        const file = String(relative).replace(/\\/g, "/");
        if (![".js", ".jsx", ".mjs", ".cjs"].includes(extname(file))) continue;
        // Only the adapter itself and the approved conversion boundary may
        // mention the adapter under lib/.
        if (dir === "lib" && allowedLibImporters.has(file)) continue;
        const text = readFileSync(join(root, dir, file), "utf8");
        if (text.includes("inventoryUnitAdapter")) {
          offenders.push(`${dir}/${file}`);
        }
      }
    }

    assert.deepEqual(offenders, []);
  });
});
