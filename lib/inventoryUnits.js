// BONO Inventory — Phase 2, Step 1: isolated unit normalization.
//
// PURPOSE
// -------
// Normalize the inventory unit vocabulary that exists in V1 free-text fields
// (for example "KG", "litre", "each") into the canonical accounting units used
// by Inventory V2: g, ml, and pcs.
//
// This module is deliberately standalone:
//   - no database/Mongoose import;
//   - no environment access;
//   - no application, route, model, or V2 runtime import;
//   - no side effects at import time.
//
// It is NOT wired into reservation, deduction, order, payment, or waste paths.
// Callers must opt in explicitly. Nothing here silently rewrites existing
// InventoryItem.unit, recipe units, stock values, or historical movements.
//
// CANONICAL CONTRACT
// ------------------
// Dimensions: MASS, VOLUME, COUNT.
// Canonical units: g, ml, pcs.
//
// Exact quantities use the same representation as Inventory V2:
//
//   { unit, canonicalUnit, scaled }
//
// where `scaled` is a BigInt in canonical base units at 10^6
// (1 scaled unit = 1e-6 g/ml/pcs). Parsing is decimal-string based and never
// multiplies binary floating-point numbers. Values that cannot be represented
// exactly are rejected, never rounded.
//
// COMPATIBILITY
// -------------
// `normalizeUnit()` maps every accepted alias to one of the V2 approved unit
// labels (`kg`, `g`, `L`, `ml`, `pcs`) while exposing the canonical accounting
// unit (`g`, `ml`, `pcs`). Conversion results therefore use the same
// `{ unit, canonicalUnit, scaled, value }` shape as `lib/inventory-v2/domain/
// units.js` and can be adapted later without reinterpreting quantities.
//
// Unsupported aliases are rejected. V1 free-text values such as "oz", "lb",
// "cup", "tbsp", "pack", "box", or "unit" are intentionally NOT guessed.

export const DIMENSIONS = Object.freeze({
  MASS: "MASS",
  VOLUME: "VOLUME",
  COUNT: "COUNT",
});

export const CANONICAL_UNITS = Object.freeze({
  MASS: "g",
  VOLUME: "ml",
  COUNT: "pcs",
});

export const CANONICAL_UNIT_LIST = Object.freeze(["g", "ml", "pcs"]);

// Keep these values aligned with the V2 exact quantity contract.
export const QTY_SCALE_DIGITS = 6;
export const QTY_SCALE = 1_000_000n;
export const MAX_SCALED_QUANTITY = 100_000_000_000_000n;

// Stable machine-readable error codes. The unit codes intentionally match the
// independently owned V2 vocabulary so a future adapter can map them directly.
export const UNIT_ERROR_CODES = Object.freeze({
  UNKNOWN_UNIT: "UNKNOWN_UNIT",
  UNIT_DIMENSION_MISMATCH: "UNIT_DIMENSION_MISMATCH",
  INVALID_QUANTITY: "INVALID_QUANTITY",
  NEGATIVE_QUANTITY: "NEGATIVE_QUANTITY",
  QUANTITY_PRECISION_UNSUPPORTED: "QUANTITY_PRECISION_UNSUPPORTED",
  QUANTITY_OUT_OF_RANGE: "QUANTITY_OUT_OF_RANGE",
});

export class InventoryUnitError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = "InventoryUnitError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isInventoryUnitError(error, code) {
  return (
    error instanceof InventoryUnitError &&
    (code === undefined || error.code === code)
  );
}

function fail(code, message, details) {
  throw new InventoryUnitError(code, message, details);
}

// ---------------------------------------------------------------------------
// Explicit unit vocabulary
// ---------------------------------------------------------------------------

function powerOfTenExponent(value) {
  let current = value;
  let exponent = 0;
  while (current > 1n && current % 10n === 0n) {
    current /= 10n;
    exponent += 1;
  }
  return current === 1n ? exponent : null;
}

function makeDefinition(
  sourceUnit,
  canonicalUnit,
  dimension,
  factorNumerator,
  factorDenominator
) {
  const numeratorExponent = powerOfTenExponent(factorNumerator);
  const denominatorExponent = powerOfTenExponent(factorDenominator);
  if (numeratorExponent === null || denominatorExponent === null) {
    throw new Error("Inventory unit factors must be exact powers of ten");
  }
  return Object.freeze({
    sourceUnit,
    unit: canonicalUnit,
    canonicalUnit,
    dimension,
    factorNumerator,
    factorDenominator,
    // Decimal places needed to display a canonical scaled value in this unit.
    displayDecimals:
      QTY_SCALE_DIGITS + numeratorExponent - denominatorExponent,
  });
}

const DEFINITIONS = {
  g: makeDefinition("g", CANONICAL_UNITS.MASS, DIMENSIONS.MASS, 1n, 1n),
  kg: makeDefinition("kg", CANONICAL_UNITS.MASS, DIMENSIONS.MASS, 1000n, 1n),
  ml: makeDefinition("ml", CANONICAL_UNITS.VOLUME, DIMENSIONS.VOLUME, 1n, 1n),
  L: makeDefinition("L", CANONICAL_UNITS.VOLUME, DIMENSIONS.VOLUME, 1000n, 1n),
  pcs: makeDefinition("pcs", CANONICAL_UNITS.COUNT, DIMENSIONS.COUNT, 1n, 1n),
};

export const UNIT_DEFINITIONS = Object.freeze(DEFINITIONS);

// Explicit aliases only. Singular/plural spellings are listed separately so the
// accepted vocabulary is auditable. No density or mass/volume inference exists.
const ALIAS_GROUPS = Object.freeze({
  g: Object.freeze(["g", "gram", "grams"]),
  kg: Object.freeze(["kg", "kilogram", "kilograms", "kgs"]),
  ml: Object.freeze([
    "ml",
    "millilitre",
    "millilitres",
    "milliliter",
    "milliliters",
  ]),
  L: Object.freeze(["l", "litre", "litres", "liter", "liters"]),
  // "bottle" and "can" mean a countable container here — never a volume.
  pcs: Object.freeze([
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
  ]),
});

const aliasEntries = [];
for (const [definitionKey, aliases] of Object.entries(ALIAS_GROUPS)) {
  const definition = DEFINITIONS[definitionKey];
  for (const alias of aliases) {
    aliasEntries.push([alias, definition]);
  }
}

export const UNIT_ALIASES = Object.freeze(Object.fromEntries(aliasEntries));

export const SUPPORTED_UNIT_ALIASES = Object.freeze(
  aliasEntries.map(([alias]) => alias)
);

// Rejection list: container, vessel, and portion nouns that must never be
// auto-converted. It assigns no dimension and no factor, so it is not an alias
// table. It lives beside the alias table so the adapter and the write-boundary
// guard share one copy instead of maintaining competing vocabularies.
//
// `oz` is intentionally absent: it is rejected as UNKNOWN_UNIT, and its
// mass-vs-fluid-ounce ambiguity remains an open policy question.
export const AMBIGUOUS_UNITS = Object.freeze([
  "bottle",
  "bottles",
  "can",
  "cans",
  "pack",
  "packs",
  "packet",
  "packets",
  "box",
  "boxes",
  "bag",
  "bags",
  "tin",
  "tins",
  "jar",
  "jars",
  "sachet",
  "sachets",
  "tray",
  "trays",
  "loaf",
  "loaves",
  "bunch",
  "bunches",
  "head",
  "heads",
  "clove",
  "cloves",
  "slice",
  "slices",
  "cup",
  "cups",
  "shot",
  "shots",
  "dash",
  "pinch",
  "unit",
  "units",
  "item",
  "items",
]);

// ---------------------------------------------------------------------------
// Unit normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an explicit alias to its canonical accounting unit.
 *
 * Matching is case-insensitive and trims surrounding whitespace, matching the
 * existing V1 `normalizeUnit()`/receive-idempotency behaviour. Internal spaces,
 * punctuation, and unseen aliases are rejected rather than guessed.
 *
 * @returns {Readonly<{
 *   input: string,
 *   unit: string,
 *   canonicalUnit: string,
 *   dimension: string,
 *   sourceUnit: string,
 *   factorNumerator: bigint,
 *   factorDenominator: bigint
 * }>}
 */
export function normalizeUnit(unit, field = "unit") {
  if (typeof unit !== "string") {
    fail(
      UNIT_ERROR_CODES.UNKNOWN_UNIT,
      `${field} must be a supported inventory unit string`,
      {
        field,
        unit,
        supportedAliases: SUPPORTED_UNIT_ALIASES,
      }
    );
  }

  const trimmed = unit.trim();
  const alias = trimmed.toLowerCase();
  const definition = alias ? UNIT_ALIASES[alias] : undefined;

  if (!definition) {
    fail(
      UNIT_ERROR_CODES.UNKNOWN_UNIT,
      `${field} is not a supported inventory unit alias`,
      {
        field,
        unit,
        supportedAliases: SUPPORTED_UNIT_ALIASES,
      }
    );
  }

  return Object.freeze({
    input: unit,
    unit: definition.unit,
    canonicalUnit: definition.canonicalUnit,
    dimension: definition.dimension,
    sourceUnit: definition.sourceUnit,
    factorNumerator: definition.factorNumerator,
    factorDenominator: definition.factorDenominator,
    displayDecimals: definition.displayDecimals,
  });
}

export function canNormalizeUnit(unit) {
  try {
    normalizeUnit(unit);
    return true;
  } catch {
    return false;
  }
}

function greatestCommonDivisor(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0n ? 1n : a;
}

function resolveUnitPair(fromUnit, toUnit) {
  const from = normalizeUnit(fromUnit, "fromUnit");
  const to = normalizeUnit(toUnit, "toUnit");

  if (from.dimension !== to.dimension) {
    fail(
      UNIT_ERROR_CODES.UNIT_DIMENSION_MISMATCH,
      "Mass, volume, and count units cannot be converted across dimensions",
      {
        fromUnit,
        toUnit,
        fromDimension: from.dimension,
        toDimension: to.dimension,
      }
    );
  }

  return { from, to };
}

/**
 * Exact conversion factor as a reduced rational number:
 *
 *   quantityInTarget = quantityInSource * numerator / denominator
 *
 * Both values are BigInt. No floating-point factor is returned.
 */
export function getConversionFactorExact(fromUnit, toUnit) {
  const { from, to } = resolveUnitPair(fromUnit, toUnit);

  const rawNumerator = from.factorNumerator * to.factorDenominator;
  const rawDenominator = from.factorDenominator * to.factorNumerator;
  const divisor = greatestCommonDivisor(rawNumerator, rawDenominator);

  return Object.freeze({
    numerator: rawNumerator / divisor,
    denominator: rawDenominator / divisor,
    fromUnit: from.sourceUnit,
    toUnit: to.sourceUnit,
  });
}

export function isSupportedConversion(fromUnit, toUnit) {
  try {
    getConversionFactorExact(fromUnit, toUnit);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exact quantity parsing and conversion
// ---------------------------------------------------------------------------

const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const MAX_DECIMAL_TEXT_LENGTH = 64;
const MAX_EXPONENT_MAGNITUDE = 1000;
const MAX_POSITIVE_SCALE_SHIFT = 64;

function valueToDecimalString(value, field) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(
        UNIT_ERROR_CODES.INVALID_QUANTITY,
        `${field} must be a finite number`,
        { field, value }
      );
    }
    return String(value);
  }

  if (typeof value === "string") {
    if (value.length === 0 || value.trim() !== value) {
      fail(
        UNIT_ERROR_CODES.INVALID_QUANTITY,
        `${field} must be a non-empty decimal string without surrounding whitespace`,
        { field, value }
      );
    }
    if (value.length > MAX_DECIMAL_TEXT_LENGTH) {
      fail(
        UNIT_ERROR_CODES.QUANTITY_OUT_OF_RANGE,
        `${field} decimal text is too long`,
        { field, length: value.length, maxLength: MAX_DECIMAL_TEXT_LENGTH }
      );
    }
    return value;
  }

  fail(
    UNIT_ERROR_CODES.INVALID_QUANTITY,
    `${field} must be a number or decimal string`,
    { field, value }
  );
}

/**
 * Parse a decimal value in `definition` into canonical scaled units.
 *
 * `definition.factorNumerator / factorDenominator` converts the input unit to
 * its canonical base. The result is always g/ml/pcs at 10^6. Precision that
 * cannot be represented exactly is rejected with
 * QUANTITY_PRECISION_UNSUPPORTED; it is never rounded or truncated.
 */
function parseQuantityToScaled(value, definition, field) {
  const text = valueToDecimalString(value, field);
  const match = DECIMAL_PATTERN.exec(text);

  if (!match) {
    fail(
      UNIT_ERROR_CODES.INVALID_QUANTITY,
      `${field} is not a decimal value`,
      { field, value }
    );
  }

  const sign = match[1];
  const integerPart = match[2] || "";
  const fractionPart = match[3] || "";
  const exponentText = match[4] === undefined ? "0" : match[4];

  if (integerPart.length === 0 && fractionPart.length === 0) {
    fail(
      UNIT_ERROR_CODES.INVALID_QUANTITY,
      `${field} has no digits`,
      { field, value }
    );
  }

  const exponent = Number(exponentText);
  if (
    !Number.isSafeInteger(exponent) ||
    Math.abs(exponent) > MAX_EXPONENT_MAGNITUDE
  ) {
    fail(
      UNIT_ERROR_CODES.QUANTITY_OUT_OF_RANGE,
      `${field} exponent is outside the supported range`,
      { field, value, maxExponentMagnitude: MAX_EXPONENT_MAGNITUDE }
    );
  }

  const digits = `${integerPart}${fractionPart}`;
  const shift = exponent - fractionPart.length + QTY_SCALE_DIGITS;

  let numerator = BigInt(digits) * definition.factorNumerator;
  let denominator = definition.factorDenominator;

  if (shift >= 0) {
    if (shift > MAX_POSITIVE_SCALE_SHIFT) {
      fail(
        UNIT_ERROR_CODES.QUANTITY_OUT_OF_RANGE,
        `${field} would exceed the supported quantity bound`,
        { field, value }
      );
    }
    numerator *= 10n ** BigInt(shift);
  } else {
    denominator *= 10n ** BigInt(-shift);
  }

  if (numerator % denominator !== 0n) {
    fail(
      UNIT_ERROR_CODES.QUANTITY_PRECISION_UNSUPPORTED,
      `${field} has more precision than the exact representation supports`,
      { field, value }
    );
  }

  let scaled = numerator / denominator;
  if (sign === "-") scaled = -scaled;

  if (scaled < 0n) {
    fail(
      UNIT_ERROR_CODES.NEGATIVE_QUANTITY,
      `${field} must not be negative`,
      { field, value }
    );
  }

  if (scaled > MAX_SCALED_QUANTITY) {
    fail(
      UNIT_ERROR_CODES.QUANTITY_OUT_OF_RANGE,
      `${field} exceeds the supported quantity bound`,
      {
        field,
        value,
        maxScaled: MAX_SCALED_QUANTITY.toString(),
      }
    );
  }

  return scaled === 0n ? 0n : scaled;
}

/** Format a canonical scaled BigInt as an exact decimal string. */
export function formatScaledQuantity(
  scaled,
  { decimals = QTY_SCALE_DIGITS, trim = true } = {}
) {
  if (typeof scaled !== "bigint") {
    fail(
      UNIT_ERROR_CODES.INVALID_QUANTITY,
      "scaled quantity must be a BigInt",
      { value: scaled }
    );
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    fail(
      UNIT_ERROR_CODES.INVALID_QUANTITY,
      "decimals must be an integer 0..18",
      { decimals }
    );
  }

  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const factor = 10n ** BigInt(decimals);
  const whole = absolute / factor;
  const remainder = (absolute % factor).toString().padStart(decimals, "0");
  const fraction = trim ? remainder.replace(/0+$/, "") : remainder;

  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Convert an input quantity to canonical g/ml/pcs.
 *
 * @returns {Readonly<{
 *   unit: string,
 *   canonicalUnit: string,
 *   dimension: string,
 *   scaled: bigint,
 *   value: string
 * }>}
 */
export function toCanonicalQuantity(value, unit, field = "quantity") {
  const definition = normalizeUnit(unit, "unit");
  const scaled = parseQuantityToScaled(value, definition, field);

  return Object.freeze({
    unit: definition.unit,
    canonicalUnit: definition.canonicalUnit,
    dimension: definition.dimension,
    scaled,
    value: formatScaledQuantity(scaled, { decimals: QTY_SCALE_DIGITS }),
  });
}

/**
 * Exact conversion between two units of the same dimension.
 *
 * The returned `scaled` value is always canonical; `unit` is the canonical
 * spelling of the requested target alias (`kg`, `g`, `L`, `ml`, or `pcs`) and
 * `value` is formatted in that target unit. Cross-dimension pairs are rejected
 * before the quantity is parsed.
 *
 * @returns {Readonly<{
 *   unit: string,
 *   canonicalUnit: string,
 *   dimension: string,
 *   scaled: bigint,
 *   value: string
 * }>}
 */
export function convertQuantityExact(
  value,
  fromUnit,
  toUnit,
  field = "quantity"
) {
  const { from, to } = resolveUnitPair(fromUnit, toUnit);
  const scaled = parseQuantityToScaled(value, from, field);

  return Object.freeze({
    unit: to.sourceUnit,
    canonicalUnit: to.canonicalUnit,
    dimension: to.dimension,
    scaled,
    value: formatScaledQuantity(scaled, {
      decimals: to.displayDecimals,
    }),
  });
}
