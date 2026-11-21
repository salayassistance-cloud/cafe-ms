// BONO Inventory V2 — approved unit conversion allowlist.
//
// Canonical accounting units are g, ml, and pcs. The only supported conversion
// pairs are:
//
//   kg <-> g    factor 1000
//   L  <-> ml   factor 1000
//   pcs <-> pcs factor 1
//
// Mass-to-volume conversion, density inference, unknown units, aliases such as
// "KG" or "l", and every other pair are rejected. Unit names are matched
// exactly; there is no silent trimming, case folding, or alias normalization.
//
// Exact representation
// --------------------
// Every exact quantity stores `scaled` in canonical base units at 1e-6. Because
// kg and L are 1000× larger, their maximum exact input precision is 9 decimal
// places (1e-9 kg = 1e-6 g = 1 scaled unit). This lets every canonical value
// round-trip through kg/L without drift.
//
// Conversion never rounds. `convertQuantity()` returns a Number display
// projection only; accounting code must use `convertQuantityExact()`.

import {
  ERROR_CODES,
  fail,
} from "./errors.js";
import {
  EXACT_QUANTITY_ERRORS,
  MAX_SCALED_QUANTITY,
  QTY_SCALE_DIGITS,
  formatScaledQuantity,
  parseScaledQuantity,
} from "./quantity.js";

export const CANONICAL_ACCOUNTING_UNITS = Object.freeze(["g", "ml", "pcs"]);

export const APPROVED_UNITS = Object.freeze(["kg", "g", "L", "ml", "pcs"]);

export const UNIT_DEFINITIONS = Object.freeze({
  kg: Object.freeze({ dimension: "MASS", baseUnit: "g", toBase: 1000n }),
  g: Object.freeze({ dimension: "MASS", baseUnit: "g", toBase: 1n }),
  L: Object.freeze({ dimension: "VOLUME", baseUnit: "ml", toBase: 1000n }),
  ml: Object.freeze({ dimension: "VOLUME", baseUnit: "ml", toBase: 1n }),
  pcs: Object.freeze({ dimension: "COUNT", baseUnit: "pcs", toBase: 1n }),
});

export const SUPPORTED_UNIT_PAIRS = Object.freeze([
  Object.freeze(["kg", "g"]),
  Object.freeze(["g", "kg"]),
  Object.freeze(["L", "ml"]),
  Object.freeze(["ml", "L"]),
  Object.freeze(["pcs", "pcs"]),
]);

const SUPPORTED_PAIR_KEYS = new Set(
  SUPPORTED_UNIT_PAIRS.map(([from, to]) => `${from}>${to}`)
);

function powerOfTenExponent(value) {
  if (value === 1n) return 0;
  if (value === 1000n) return 3;
  fail(ERROR_CODES.INVALID_INPUT, "Unsupported unit scale", { value });
}

/**
 * Exact unit validation. Aliases (KG, L vs l, surrounding whitespace) are
 * rejected rather than normalized.
 */
export function assertApprovedUnit(unit, field = "unit") {
  if (typeof unit !== "string" || !APPROVED_UNITS.includes(unit)) {
    fail(ERROR_CODES.UNKNOWN_UNIT, "Unknown or non-canonical unit", {
      field,
      unit,
      allowed: APPROVED_UNITS,
    });
  }
  return unit;
}

export function assertCanonicalAccountingUnit(unit, field = "unit") {
  if (typeof unit !== "string" || !CANONICAL_ACCOUNTING_UNITS.includes(unit)) {
    fail(ERROR_CODES.UNKNOWN_UNIT, "Unit is not a canonical accounting unit", {
      field,
      unit,
      allowed: CANONICAL_ACCOUNTING_UNITS,
    });
  }
  return unit;
}

export function getConversionFactorExact(fromUnit, toUnit) {
  const from = assertApprovedUnit(fromUnit, "fromUnit");
  const to = assertApprovedUnit(toUnit, "toUnit");
  const fromDef = UNIT_DEFINITIONS[from];
  const toDef = UNIT_DEFINITIONS[to];

  if (fromDef.dimension !== toDef.dimension) {
    fail(
      ERROR_CODES.UNIT_DIMENSION_MISMATCH,
      "Mass, volume, and count units cannot be converted across dimensions",
      {
        fromUnit: from,
        toUnit: to,
        fromDimension: fromDef.dimension,
        toDimension: toDef.dimension,
      }
    );
  }

  if (!SUPPORTED_PAIR_KEYS.has(`${from}>${to}`)) {
    fail(
      ERROR_CODES.UNSUPPORTED_UNIT_CONVERSION,
      "Unit pair is not in the approved conversion allowlist",
      { fromUnit: from, toUnit: to, supportedPairs: SUPPORTED_UNIT_PAIRS }
    );
  }

  return Object.freeze({
    numerator: fromDef.toBase,
    denominator: toDef.toBase,
  });
}

/**
 * Legacy numeric factor. Returns 1000, 0.001, or 1 for the approved pairs.
 * Exact conversion code uses getConversionFactorExact().
 */
export function getConversionFactor(fromUnit, toUnit) {
  const { numerator, denominator } = getConversionFactorExact(
    fromUnit,
    toUnit
  );
  return Number(numerator) / Number(denominator);
}

export function isSupportedConversion(fromUnit, toUnit) {
  try {
    getConversionFactorExact(fromUnit, toUnit);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a value expressed in `unit` into a canonical exact quantity.
 *
 * @returns {Readonly<{unit: string, canonicalUnit: string, scaled: bigint, value: string}>}
 */
export function parseQuantityInUnit(value, unit, field = "quantity") {
  const safeUnit = assertApprovedUnit(unit, "unit");
  const definition = UNIT_DEFINITIONS[safeUnit];
  const exponent = powerOfTenExponent(definition.toBase);
  const decimals = QTY_SCALE_DIGITS + exponent;
  const scaled = parseScaledQuantity(value, field, { decimals });
  return Object.freeze({
    unit: safeUnit,
    canonicalUnit: definition.baseUnit,
    scaled,
    value: formatQuantityInUnit(scaled, safeUnit),
  });
}

/** Format a canonical scaled value in the requested approved unit. */
export function formatQuantityInUnit(scaled, unit) {
  const safeUnit = assertApprovedUnit(unit, "unit");
  const definition = UNIT_DEFINITIONS[safeUnit];
  const exponent = powerOfTenExponent(definition.toBase);
  return formatScaledQuantity(scaled, {
    decimals: QTY_SCALE_DIGITS + exponent,
  });
}

/**
 * Exact conversion. The returned `scaled` value is always canonical (g/ml/pcs
 * at 1e-6); only the unit label and exact display string change.
 */
export function convertQuantityExact(quantity, fromUnit, toUnit) {
  const source = assertApprovedUnit(fromUnit, "fromUnit");
  const target = assertApprovedUnit(toUnit, "toUnit");
  getConversionFactorExact(source, target);

  const parsed = parseQuantityInUnit(quantity, source, "quantity");
  if (parsed.scaled > MAX_SCALED_QUANTITY) {
    fail(
      EXACT_QUANTITY_ERRORS.QUANTITY_OUT_OF_RANGE,
      "Converted quantity exceeds the supported bound",
      { quantity, fromUnit: source, toUnit: target }
    );
  }

  return Object.freeze({
    unit: target,
    canonicalUnit: UNIT_DEFINITIONS[target].baseUnit,
    scaled: parsed.scaled,
    value: formatQuantityInUnit(parsed.scaled, target),
  });
}

/** Number display projection of an exact conversion. */
export function convertQuantity(quantity, fromUnit, toUnit) {
  return Number(convertQuantityExact(quantity, fromUnit, toUnit).value);
}

/**
 * Exact accounting conversion. Returns the exact quantity object; no rounding
 * occurs at this boundary.
 */
export function convertQuantityForAccounting(quantity, fromUnit, toUnit) {
  return convertQuantityExact(quantity, fromUnit, toUnit);
}

// ---------------------------------------------------------------------------
// Exact quantity wire representation (Phase 1.4)
// ---------------------------------------------------------------------------
//
// Wire contract (no BigInt and no floating point on the wire):
//
//   { unit, canonicalUnit, scaled: "integer string" }
//
// `scaled` is the canonical g/ml/pcs value at 10^6, written as a base-10
// integer string with no exponent, sign prefix "+", decimal point, whitespace,
// or leading zeros (except the single character "0"). Ingestion revalidates the
// string and reconstructs the BigInt; a numeric projection is never accepted as
// authoritative. See the Phase 2 note in the implementation report.

export const EXACT_QUANTITY_WIRE_VERSION = "quantity-wire-v1";
// P2-02: signed deltas use a separate, explicitly signed wire version. A
// physical inventory quantity can never be encoded as a negative value.
export const EXACT_SIGNED_QUANTITY_WIRE_VERSION = "quantity-wire-signed-v1";

const WIRE_SCALED_PATTERN = /^(0|[1-9]\d*)$/;
const WIRE_SIGNED_SCALED_PATTERN = /^-?(0|[1-9]\d*)$/;

function assertWireVersion(input, expectedVersion, field) {
  if (input.version !== expectedVersion) {
    fail(
      ERROR_CODES.UNSUPPORTED_QUANTITY_WIRE_VERSION,
      `${field}.version must be ${expectedVersion}`,
      {
        field: `${field}.version`,
        value: input.version,
        expectedVersion,
      }
    );
  }
}

function parseWireScaled(scaled, field, { allowNegative = false } = {}) {
  const pattern = allowNegative
    ? WIRE_SIGNED_SCALED_PATTERN
    : WIRE_SCALED_PATTERN;
  if (typeof scaled !== "string" || !pattern.test(scaled)) {
    fail(
      ERROR_CODES.INVALID_QUANTITY,
      allowNegative
        ? `${field} must be a signed base-10 integer string`
        : `${field} must be a non-negative base-10 integer string`,
      { field, value: scaled }
    );
  }
  let parsed;
  try {
    parsed = BigInt(scaled);
  } catch (error) {
    fail(ERROR_CODES.INVALID_QUANTITY, `${field} is not an integer`, {
      field,
      value: scaled,
      cause: error.code,
    });
  }
  if (parsed > MAX_SCALED_QUANTITY || parsed < -MAX_SCALED_QUANTITY) {
    fail(
      EXACT_QUANTITY_ERRORS.QUANTITY_OUT_OF_RANGE,
      `${field} exceeds the supported quantity bound`,
      {
        field,
        value: scaled,
        maxScaled: MAX_SCALED_QUANTITY.toString(),
      }
    );
  }
  if (!allowNegative && parsed < 0n) {
    fail(
      ERROR_CODES.NEGATIVE_QUANTITY,
      `${field} must not be negative`,
      { field, value: scaled }
    );
  }
  return parsed === 0n ? 0n : parsed;
}

/**
 * Build the canonical wire representation of an exact quantity.
 * Rejects a mismatched `canonicalUnit` instead of silently normalizing it.
 */
export function serializeExactQuantity(quantity) {
  if (!quantity || typeof quantity !== "object") {
    fail(ERROR_CODES.INVALID_QUANTITY, "Exact quantity is required");
  }
  const unit = assertApprovedUnit(quantity.unit, "unit");
  const canonicalUnit = assertCanonicalAccountingUnit(
    quantity.canonicalUnit,
    "canonicalUnit"
  );
  const expectedCanonical = UNIT_DEFINITIONS[unit].baseUnit;
  if (canonicalUnit !== expectedCanonical) {
    fail(
      ERROR_CODES.INVALID_INPUT,
      "canonicalUnit does not match the source unit",
      { unit, canonicalUnit, expectedCanonical }
    );
  }
  const scaled = parseScaledQuantity(quantity.scaled, "scaled");
  return Object.freeze({
    version: EXACT_QUANTITY_WIRE_VERSION,
    unit,
    canonicalUnit,
    scaled: scaled.toString(),
  });
}

/**
 * Validate and reconstruct an exact quantity from its wire representation.
 * The returned object is the internal exact quantity used by accounting.
 */
export function deserializeExactQuantity(input, field = "quantity") {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(ERROR_CODES.INVALID_QUANTITY, `${field} wire representation is required`, {
      field,
      value: input,
    });
  }
  assertWireVersion(input, EXACT_QUANTITY_WIRE_VERSION, field);
  const unit = assertApprovedUnit(input.unit, `${field}.unit`);
  const canonicalUnit = assertCanonicalAccountingUnit(
    input.canonicalUnit,
    `${field}.canonicalUnit`
  );
  const expectedCanonical = UNIT_DEFINITIONS[unit].baseUnit;
  if (canonicalUnit !== expectedCanonical) {
    fail(
      ERROR_CODES.INVALID_INPUT,
      `${field}.canonicalUnit does not match the source unit`,
      { field, unit, canonicalUnit, expectedCanonical }
    );
  }
  const scaled = parseWireScaled(input.scaled, `${field}.scaled`);
  return Object.freeze({
    unit,
    canonicalUnit,
    scaled,
    value: formatQuantityInUnit(scaled, unit),
  });
}

/**
 * P2-02: signed waste-correction delta wire representation. This is a distinct
 * type/version from physical inventory quantities and is the ONLY wire form
 * that may carry a negative value.
 */
export function serializeSignedExactQuantity(quantity) {
  if (!quantity || typeof quantity !== "object") {
    fail(ERROR_CODES.INVALID_QUANTITY, "Signed exact quantity is required");
  }
  const unit = assertApprovedUnit(quantity.unit, "unit");
  const canonicalUnit = assertCanonicalAccountingUnit(
    quantity.canonicalUnit,
    "canonicalUnit"
  );
  const expectedCanonical = UNIT_DEFINITIONS[unit].baseUnit;
  if (canonicalUnit !== expectedCanonical) {
    fail(
      ERROR_CODES.INVALID_INPUT,
      "canonicalUnit does not match the source unit",
      { unit, canonicalUnit, expectedCanonical }
    );
  }
  const scaled = parseScaledQuantity(quantity.scaled, "scaled", {
    allowNegative: true,
  });
  return Object.freeze({
    version: EXACT_SIGNED_QUANTITY_WIRE_VERSION,
    unit,
    canonicalUnit,
    scaled: scaled.toString(),
  });
}

export function deserializeSignedExactQuantity(input, field = "quantity") {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(ERROR_CODES.INVALID_QUANTITY, `${field} wire representation is required`, {
      field,
      value: input,
    });
  }
  assertWireVersion(input, EXACT_SIGNED_QUANTITY_WIRE_VERSION, field);
  const unit = assertApprovedUnit(input.unit, `${field}.unit`);
  const canonicalUnit = assertCanonicalAccountingUnit(
    input.canonicalUnit,
    `${field}.canonicalUnit`
  );
  const expectedCanonical = UNIT_DEFINITIONS[unit].baseUnit;
  if (canonicalUnit !== expectedCanonical) {
    fail(
      ERROR_CODES.INVALID_INPUT,
      `${field}.canonicalUnit does not match the source unit`,
      { field, unit, canonicalUnit, expectedCanonical }
    );
  }
  const scaled = parseWireScaled(input.scaled, `${field}.scaled`, {
    allowNegative: true,
  });
  return Object.freeze({
    unit,
    canonicalUnit,
    scaled,
    value: formatQuantityInUnit(scaled, unit),
  });
}
