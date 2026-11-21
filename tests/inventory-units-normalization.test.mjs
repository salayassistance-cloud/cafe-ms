// BONO Inventory — Phase 2, Step 1: isolated unit normalization tests.
//
// DB-FREE ONLY: no MongoDB/Mongoose connection is opened, no environment file
// is read, and no application route/service/model is imported or exercised.
//
// The V2 compatibility checks import the pure V2 domain unit contract only to
// prove that normalized output labels and exact scaled values remain compatible
// with the existing representation. They do not wire the new module into V2.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_UNITS,
  CANONICAL_UNIT_LIST,
  DIMENSIONS,
  MAX_SCALED_QUANTITY,
  QTY_SCALE_DIGITS,
  SUPPORTED_UNIT_ALIASES,
  UNIT_ALIASES,
  UNIT_DEFINITIONS,
  UNIT_ERROR_CODES,
  InventoryUnitError,
  canNormalizeUnit,
  convertQuantityExact,
  formatScaledQuantity,
  getConversionFactorExact,
  isSupportedConversion,
  normalizeUnit,
  toCanonicalQuantity,
} from "../lib/inventoryUnits.js";
import {
  APPROVED_UNITS,
  UNIT_DEFINITIONS as V2_UNIT_DEFINITIONS,
  parseQuantityInUnit,
} from "../lib/inventory-v2/domain/units.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, "InventoryUnitError");
    assert.equal(error.code, code);
    return true;
  });
}

describe("canonical vocabulary", () => {
  test("dimensions and canonical units are fixed", () => {
    assert.deepEqual(
      { ...DIMENSIONS },
      {
        MASS: "MASS",
        VOLUME: "VOLUME",
        COUNT: "COUNT",
      }
    );
    assert.deepEqual(
      { ...CANONICAL_UNITS },
      {
        MASS: "g",
        VOLUME: "ml",
        COUNT: "pcs",
      }
    );
    assert.deepEqual([...CANONICAL_UNIT_LIST], ["g", "ml", "pcs"]);
  });

  test("definitions expose explicit exact factors", () => {
    assert.equal(UNIT_DEFINITIONS.g.canonicalUnit, "g");
    assert.equal(UNIT_DEFINITIONS.g.factorNumerator, 1n);
    assert.equal(UNIT_DEFINITIONS.g.factorDenominator, 1n);

    assert.equal(UNIT_DEFINITIONS.kg.canonicalUnit, "g");
    assert.equal(UNIT_DEFINITIONS.kg.factorNumerator, 1000n);
    assert.equal(UNIT_DEFINITIONS.kg.factorDenominator, 1n);

    assert.equal(UNIT_DEFINITIONS.ml.canonicalUnit, "ml");
    assert.equal(UNIT_DEFINITIONS.ml.factorNumerator, 1n);

    assert.equal(UNIT_DEFINITIONS.L.canonicalUnit, "ml");
    assert.equal(UNIT_DEFINITIONS.L.factorNumerator, 1000n);
    assert.equal(UNIT_DEFINITIONS.L.factorDenominator, 1n);

    assert.equal(UNIT_DEFINITIONS.pcs.canonicalUnit, "pcs");
    assert.equal(UNIT_DEFINITIONS.pcs.factorNumerator, 1n);
  });
});

describe("explicit alias normalization", () => {
  test("mass aliases map to g; kg scales by exactly 1000", () => {
    for (const alias of ["g", "gram", "grams", " G "]) {
      const normalized = normalizeUnit(alias);
      assert.equal(normalized.unit, "g");
      assert.equal(normalized.canonicalUnit, "g");
      assert.equal(normalized.sourceUnit, "g");
      assert.equal(normalized.dimension, DIMENSIONS.MASS);
      assert.equal(normalized.factorNumerator, 1n);
      assert.equal(normalized.factorDenominator, 1n);
    }

    for (const alias of ["kg", "kilogram", "kilograms", "kgs", "KG", " Kg "]) {
      const normalized = normalizeUnit(alias);
      assert.equal(normalized.unit, "g");
      assert.equal(normalized.canonicalUnit, "g");
      assert.equal(normalized.sourceUnit, "kg");
      assert.equal(normalized.dimension, DIMENSIONS.MASS);
      assert.equal(normalized.factorNumerator, 1000n);
      assert.equal(normalized.factorDenominator, 1n);
    }
  });

  test("volume aliases map to ml; L/litre/liter scale by exactly 1000", () => {
    for (const alias of [
      "ml",
      "millilitre",
      "millilitres",
      "milliliter",
      "milliliters",
      "mL",
    ]) {
      const normalized = normalizeUnit(alias);
      assert.equal(normalized.unit, "ml");
      assert.equal(normalized.canonicalUnit, "ml");
      assert.equal(normalized.sourceUnit, "ml");
      assert.equal(normalized.dimension, DIMENSIONS.VOLUME);
      assert.equal(normalized.factorNumerator, 1n);
    }

    for (const alias of ["l", "L", "litre", "litres", "liter", "liters", " L "]) {
      const normalized = normalizeUnit(alias);
      assert.equal(normalized.unit, "ml");
      assert.equal(normalized.canonicalUnit, "ml");
      assert.equal(normalized.sourceUnit, "L");
      assert.equal(normalized.dimension, DIMENSIONS.VOLUME);
      assert.equal(normalized.factorNumerator, 1000n);
      assert.equal(normalized.factorDenominator, 1n);
    }
  });

  test("countable aliases map to pcs only", () => {
    for (const alias of [
      "pcs",
      "pc",
      "piece",
      "pieces",
      "each",
      "ea",
      "bottle",
      "bottles",
      "can",
      "cans",
      "EACH",
      " Bottle ",
    ]) {
      const normalized = normalizeUnit(alias);
      assert.equal(normalized.unit, "pcs");
      assert.equal(normalized.canonicalUnit, "pcs");
      assert.equal(normalized.sourceUnit, "pcs");
      assert.equal(normalized.dimension, DIMENSIONS.COUNT);
      assert.equal(normalized.factorNumerator, 1n);
      assert.equal(normalized.factorDenominator, 1n);
    }

    // A bottle/can is a countable container in this vocabulary, not a volume.
    assert.equal(UNIT_ALIASES.bottle, UNIT_ALIASES.each);
    assert.equal(UNIT_ALIASES.can, UNIT_ALIASES.piece);
  });

  test("unsupported and ambiguous aliases fail closed", () => {
    const unsupported = [
      "oz",
      "ounce",
      "lb",
      "lbs",
      "cup",
      "tbsp",
      "tsp",
      "unit",
      "units",
      "pack",
      "packet",
      "box",
      "bag",
      "tin",
      "jar",
      "sachet",
      "dozen",
      "slice",
      "shot",
      "ml.",
      "kg/",
      "k g",
    ];

    for (const alias of unsupported) {
      assert.equal(canNormalizeUnit(alias), false, alias);
      throwsCode(
        () => normalizeUnit(alias),
        UNIT_ERROR_CODES.UNKNOWN_UNIT
      );
    }
  });

  test("non-string and blank unit values fail closed", () => {
    for (const value of [null, undefined, 1, true, {}, [], ""]) {
      assert.equal(canNormalizeUnit(value), false);
      throwsCode(
        () => normalizeUnit(value),
        UNIT_ERROR_CODES.UNKNOWN_UNIT
      );
    }
    throwsCode(
      () => normalizeUnit("   "),
      UNIT_ERROR_CODES.UNKNOWN_UNIT
    );
  });

  test("the accepted alias list is explicit", () => {
    assert.ok(SUPPORTED_UNIT_ALIASES.includes("kg"));
    assert.ok(SUPPORTED_UNIT_ALIASES.includes("litre"));
    assert.ok(SUPPORTED_UNIT_ALIASES.includes("each"));
    assert.ok(!SUPPORTED_UNIT_ALIASES.includes("oz"));
    assert.ok(!SUPPORTED_UNIT_ALIASES.includes("unit"));
  });
});

describe("exact conversion factors", () => {
  test("same-dimension factors are reduced rational BigInts", () => {
    const kgToG = getConversionFactorExact("kg", "g");
    assert.equal(kgToG.numerator, 1000n);
    assert.equal(kgToG.denominator, 1n);
    assert.equal(kgToG.fromUnit, "kg");
    assert.equal(kgToG.toUnit, "g");

    const gToKg = getConversionFactorExact("g", "kg");
    assert.equal(gToKg.numerator, 1n);
    assert.equal(gToKg.denominator, 1000n);

    const litreToMl = getConversionFactorExact("litre", "ml");
    assert.equal(litreToMl.numerator, 1000n);
    assert.equal(litreToMl.denominator, 1n);
    assert.equal(litreToMl.fromUnit, "L");

    const mlToLiter = getConversionFactorExact("ml", "liter");
    assert.equal(mlToLiter.numerator, 1n);
    assert.equal(mlToLiter.denominator, 1000n);
    assert.equal(mlToLiter.toUnit, "L");

    const eachToPcs = getConversionFactorExact("each", "pcs");
    assert.equal(eachToPcs.numerator, 1n);
    assert.equal(eachToPcs.denominator, 1n);

    const bottleToCan = getConversionFactorExact("bottle", "can");
    assert.equal(bottleToCan.numerator, 1n);
    assert.equal(bottleToCan.denominator, 1n);
    assert.equal(bottleToCan.fromUnit, "pcs");
    assert.equal(bottleToCan.toUnit, "pcs");

    const gToG = getConversionFactorExact("gram", "g");
    assert.equal(gToG.numerator, 1n);
    assert.equal(gToG.denominator, 1n);
  });

  test("cross-dimension factors are strictly rejected", () => {
    const crossDimensionPairs = [
      ["kg", "ml"],
      ["L", "g"],
      ["pcs", "g"],
      ["bottle", "ml"],
      ["each", "kg"],
    ];

    for (const [from, to] of crossDimensionPairs) {
      throwsCode(
        () => getConversionFactorExact(from, to),
        UNIT_ERROR_CODES.UNIT_DIMENSION_MISMATCH
      );
      assert.equal(isSupportedConversion(from, to), false);
    }
  });

  test("unknown units are rejected before any conversion", () => {
    throwsCode(
      () => getConversionFactorExact("oz", "g"),
      UNIT_ERROR_CODES.UNKNOWN_UNIT
    );
    throwsCode(
      () => getConversionFactorExact("kg", "lb"),
      UNIT_ERROR_CODES.UNKNOWN_UNIT
    );
    assert.equal(isSupportedConversion("kg", "lb"), false);
  });

  test("supported same-dimension conversions are reported explicitly", () => {
    assert.equal(isSupportedConversion("kg", "g"), true);
    assert.equal(isSupportedConversion("g", "kg"), true);
    assert.equal(isSupportedConversion("litre", "ml"), true);
    assert.equal(isSupportedConversion("each", "pcs"), true);
    assert.equal(isSupportedConversion("pcs", "pcs"), true);
  });
});

describe("exact conversions", () => {
  test("kg converts to g without floating-point drift", () => {
    const converted = convertQuantityExact(2, "kg", "g");
    assert.equal(converted.unit, "g");
    assert.equal(converted.canonicalUnit, "g");
    assert.equal(converted.dimension, DIMENSIONS.MASS);
    assert.equal(converted.scaled, 2_000_000_000n);
    assert.equal(converted.value, "2000");

    assert.equal(convertQuantityExact(1.2345, "kg", "g").value, "1234.5");
    assert.equal(
      convertQuantityExact(1.2345, "kg", "g").scaled,
      1_234_500_000n
    );
    assert.equal(
      convertQuantityExact("0.000000001", "kg", "g").value,
      "0.000001"
    );
    assert.equal(
      convertQuantityExact("0.000000001", "kg", "g").scaled,
      1n
    );
  });

  test("g converts back to kg exactly", () => {
    const converted = convertQuantityExact(250, "g", "kg");
    assert.equal(converted.unit, "kg");
    assert.equal(converted.canonicalUnit, "g");
    assert.equal(converted.scaled, 250_000_000n);
    assert.equal(converted.value, "0.25");
  });

  test("L, litre, and liter convert to ml exactly", () => {
    const liters = convertQuantityExact(1, "L", "ml");
    assert.equal(liters.unit, "ml");
    assert.equal(liters.canonicalUnit, "ml");
    assert.equal(liters.scaled, 1_000_000_000n);
    assert.equal(liters.value, "1000");

    for (const alias of ["litre", "liter", "litres", "liters"]) {
      const converted = convertQuantityExact(0.75, alias, "ml");
      assert.equal(converted.scaled, 750_000_000n);
      assert.equal(converted.value, "750");
    }
  });

  test("ml converts back to L exactly", () => {
    const converted = convertQuantityExact(500, "ml", "L");
    assert.equal(converted.unit, "L");
    assert.equal(converted.canonicalUnit, "ml");
    assert.equal(converted.scaled, 500_000_000n);
    assert.equal(converted.value, "0.5");
  });

  test("countable aliases convert to pcs exactly", () => {
    for (const alias of ["each", "piece", "bottle", "can"]) {
      const converted = convertQuantityExact(3, alias, "pcs");
      assert.equal(converted.unit, "pcs");
      assert.equal(converted.canonicalUnit, "pcs");
      assert.equal(converted.dimension, DIMENSIONS.COUNT);
      assert.equal(converted.scaled, 3_000_000n);
      assert.equal(converted.value, "3");
    }

    const fromPcs = convertQuantityExact(4, "pcs", "each");
    assert.equal(fromPcs.unit, "pcs");
    assert.equal(fromPcs.scaled, 4_000_000n);
    assert.equal(fromPcs.value, "4");
  });

  test("repeated mass and volume conversions do not drift", () => {
    let massValue = "0.1";
    let massUnit = "g";
    for (let index = 0; index < 20; index += 1) {
      const converted = convertQuantityExact(
        massValue,
        massUnit,
        massUnit === "g" ? "kg" : "g"
      );
      assert.equal(converted.scaled, 100_000n);
      massValue = converted.value;
      massUnit = converted.unit;
    }
    assert.equal(massValue, "0.1");
    assert.equal(massUnit, "g");

    let volumeValue = "0.5";
    let volumeUnit = "ml";
    for (let index = 0; index < 20; index += 1) {
      const converted = convertQuantityExact(
        volumeValue,
        volumeUnit,
        volumeUnit === "ml" ? "L" : "ml"
      );
      assert.equal(converted.scaled, 500_000n);
      volumeValue = converted.value;
      volumeUnit = converted.unit;
    }
    assert.equal(volumeValue, "0.5");
    assert.equal(volumeUnit, "ml");
  });

  test("cross-dimension conversion is rejected before quantity parsing", () => {
    throwsCode(
      () => convertQuantityExact("not-a-number", "kg", "ml"),
      UNIT_ERROR_CODES.UNIT_DIMENSION_MISMATCH
    );
    throwsCode(
      () => convertQuantityExact(1, "pcs", "g"),
      UNIT_ERROR_CODES.UNIT_DIMENSION_MISMATCH
    );
  });
});

describe("exact canonical quantities", () => {
  test("well-known decimal quantities are exact", () => {
    assert.equal(toCanonicalQuantity("0.1", "kg").scaled, 100_000_000n);
    assert.equal(toCanonicalQuantity("0.1", "kg").value, "100");
    assert.equal(toCanonicalQuantity("0.3", "kg").scaled, 300_000_000n);
    assert.equal(
      toCanonicalQuantity("0.300000001", "kg").scaled,
      300_000_001n
    );
    assert.equal(
      toCanonicalQuantity("0.300000001", "kg").value,
      "300.000001"
    );
    assert.equal(toCanonicalQuantity(1.2345, "g").scaled, 1_234_500n);
    assert.equal(toCanonicalQuantity(0.5, "g").scaled, 500_000n);
    assert.equal(toCanonicalQuantity("1e-9", "kg").scaled, 1n);
    assert.equal(toCanonicalQuantity("1e3", "g").scaled, 1_000_000_000n);
  });

  test("zero quantities are valid and remain exactly zero", () => {
    for (const [value, unit] of [
      [0, "g"],
      ["0.000000", "ml"],
      ["0", "kg"],
      [0, "each"],
      ["-0", "pcs"],
    ]) {
      const quantity = toCanonicalQuantity(value, unit);
      assert.equal(quantity.scaled, 0n);
      assert.equal(quantity.value, "0");
    }
  });

  test("the maximum exact bound is inclusive", () => {
    const quantity = toCanonicalQuantity("100000000", "g");
    assert.equal(quantity.scaled, MAX_SCALED_QUANTITY);
    throwsCode(
      () => toCanonicalQuantity("100000001", "g"),
      UNIT_ERROR_CODES.QUANTITY_OUT_OF_RANGE
    );
  });

  test("unsupported precision is rejected, never rounded", () => {
    throwsCode(
      () => toCanonicalQuantity(1.2345678, "g"),
      UNIT_ERROR_CODES.QUANTITY_PRECISION_UNSUPPORTED
    );
    throwsCode(
      () => toCanonicalQuantity("1e-10", "kg"),
      UNIT_ERROR_CODES.QUANTITY_PRECISION_UNSUPPORTED
    );
    throwsCode(
      () => convertQuantityExact("0.0000001", "g", "kg"),
      UNIT_ERROR_CODES.QUANTITY_PRECISION_UNSUPPORTED
    );
  });

  test("negative quantities are rejected", () => {
    for (const [value, unit] of [
      [-1, "g"],
      ["-0.5", "kg"],
      ["-1e-9", "kg"],
      [-2, "each"],
    ]) {
      throwsCode(
        () => toCanonicalQuantity(value, unit),
        UNIT_ERROR_CODES.NEGATIVE_QUANTITY
      );
    }
  });

  test("malformed quantities are rejected", () => {
    const malformed = [
      "abc",
      "",
      " 1",
      "1 ",
      "1,5",
      "1.2.3",
      "--1",
      "+",
      ".",
      "1e",
      "0x10",
      null,
      undefined,
      true,
      [],
      {},
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const value of malformed) {
      throwsCode(
        () => toCanonicalQuantity(value, "g"),
        UNIT_ERROR_CODES.INVALID_QUANTITY
      );
    }
  });

  test("scaled display formatting is exact", () => {
    assert.equal(formatScaledQuantity(1_234_500n), "1.2345");
    assert.equal(formatScaledQuantity(0n), "0");
    assert.equal(formatScaledQuantity(1n, { decimals: 9 }), "0.000000001");
    assert.equal(formatScaledQuantity(1_000_000n, { decimals: 6 }), "1");
    assert.equal(
      formatScaledQuantity(1_000_000n, { decimals: 6, trim: false }),
      "1.000000"
    );
    throwsCode(
      () => formatScaledQuantity(1, { decimals: 6 }),
      UNIT_ERROR_CODES.INVALID_QUANTITY
    );
    throwsCode(
      () => formatScaledQuantity(1n, { decimals: -1 }),
      UNIT_ERROR_CODES.INVALID_QUANTITY
    );
  });

  test("quantity scale matches the V2 canonical contract", () => {
    assert.equal(QTY_SCALE_DIGITS, 6);
    assert.equal(
      toCanonicalQuantity(1, "kg").scaled,
      toCanonicalQuantity(1000, "g").scaled
    );
    assert.equal(
      toCanonicalQuantity(1, "L").scaled,
      toCanonicalQuantity(1000, "ml").scaled
    );
  });
});

describe("V1 and V2 compatibility review", () => {
  test("normalized labels and dimensions are accepted by the V2 contract", () => {
    for (const alias of SUPPORTED_UNIT_ALIASES) {
      const normalized = normalizeUnit(alias);
      assert.ok(
        APPROVED_UNITS.includes(normalized.sourceUnit),
        `${alias} -> ${normalized.sourceUnit} must be V2-approved`
      );
      assert.equal(
        V2_UNIT_DEFINITIONS[normalized.sourceUnit].baseUnit,
        normalized.canonicalUnit
      );
      assert.equal(
        V2_UNIT_DEFINITIONS[normalized.sourceUnit].dimension,
        normalized.dimension
      );
    }
  });

  test("exact scaled values agree with the V2 representation", () => {
    const cases = [
      [1, "kg"],
      [0.1, "kg"],
      ["0.000000001", "kg"],
      [1.2345, "g"],
      [2, "L"],
      [500, "ml"],
      [3, "pcs"],
    ];

    for (const [value, unit] of cases) {
      assert.equal(
        toCanonicalQuantity(value, unit).scaled,
        parseQuantityInUnit(value, unit).scaled,
        `${value} ${unit}`
      );
    }
  });

  test("V1-style trimming and case folding are explicit, not incidental", () => {
    assert.equal(normalizeUnit(" KG ").unit, "g");
    assert.equal(normalizeUnit("Litre").unit, "ml");
    assert.equal(normalizeUnit("EACH").unit, "pcs");
    // Unlike V1 free text, unseen values are never passed through unchanged.
    throwsCode(
      () => normalizeUnit("bunch"),
      UNIT_ERROR_CODES.UNKNOWN_UNIT
    );
  });

  test("the new module is standalone and DB-free", () => {
    const source = readFileSync(join(root, "lib", "inventoryUnits.js"), "utf8");

    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.doesNotMatch(source, /\brequire\s*\(/);
    assert.doesNotMatch(
      source,
      /\b(mongoose|mongodb|process\.env|readFile|writeFile|fetch)\b/
    );
  });
});
