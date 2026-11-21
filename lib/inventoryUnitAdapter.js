// BONO Inventory — Phase 2, Step 3: isolated V1 → canonical unit adapter.
//
// PURPOSE
// -------
// Translate an existing V1 (quantity, unit) pair — a free-text unit plus a
// decimal quantity, exactly as stored by V1 inventory/recipe/reservation code —
// into the canonical exact quantity representation used by Inventory V2:
//
//   { dimension, canonicalUnit, scaled }
//
// where `scaled` is a BigInt in canonical base units at 10^6
// (1 scaled unit = 1e-6 g / ml / pcs).
//
// This module is deliberately standalone:
//   - no database/Mongoose import;
//   - no environment access;
//   - no application, route, model, or V2 runtime import;
//   - no side effects at import time.
//
// It is NOT wired into reservation, deduction, order, payment, or waste paths.
// Callers must opt in explicitly. Nothing here rewrites InventoryItem.unit,
// recipe units, stock values, or historical movements: the adapter only
// *returns* a translation and always echoes the original input unchanged.
//
// CONVERSION RULES
// ----------------
// 1. Unit vocabulary comes exclusively from `lib/inventoryUnits.js`. No alias is
//    added or redefined here.
// 2. A unit label is never converted on its own. `kg` is translated together
//    with its quantity (1000 g), so `1 kg` can never become `1 g`.
// 3. Ambiguous container/portion units are rejected before alias lookup, even
//    where `lib/inventoryUnits.js` happens to accept them. In particular
//    "bottle" and "can" are NOT treated as a count: the Phase 2 Step 2 audit
//    found no evidence establishing that meaning, so this adapter refuses to
//    guess their dimension.
// 4. Null, undefined, empty, and whitespace-only units are rejected.
// 5. Unknown aliases, unsupported precision, negative quantities, and
//    cross-dimension conversions are rejected. Nothing is rounded.
//
// EXACTNESS
// ---------
// All arithmetic is the exact BigInt/rational implementation in
// `lib/inventoryUnits.js`. `scaled` is canonical at 1e-6, so:
//   - `g` and `ml` can represent every canonical value without change;
//   - `kg` and `L` display the same canonical value with 3 extra decimals
//     (1e-9 kg/L = 1e-6 g/ml), so a reverse conversion is always exact for
//     adapter-produced results;
//   - `pcs` is identity.
// The reverse helper still verifies the round trip and rejects any result whose
// recorded display value disagrees with its exact scaled quantity, throwing
// LOSSY_CONVERSION rather than silently rounding or picking one of the two.
// It never falls back to a numeric approximation.

import {
  AMBIGUOUS_UNITS,
  InventoryUnitError,
  MAX_SCALED_QUANTITY,
  QTY_SCALE_DIGITS,
  UNIT_ERROR_CODES,
  convertQuantityExact,
  formatScaledQuantity,
  normalizeUnit,
  toCanonicalQuantity,
} from "./inventoryUnits.js";

// The rejection list is owned by the pure unit vocabulary so every boundary
// reads the same copy. Re-exported here for existing adapter consumers.
export { AMBIGUOUS_UNITS };

/**
 * Adapter error codes. The V1/V2 unit codes are re-exported so callers can
 * branch on one vocabulary; the three adapter-specific codes describe
 * conditions that `lib/inventoryUnits.js` alone cannot distinguish.
 */
export const ADAPTER_ERROR_CODES = Object.freeze({
  /** Unit is null, undefined, empty, or whitespace-only. */
  MISSING_UNIT: "MISSING_UNIT",
  /** Unit is a container/portion noun whose quantity is not established. */
  AMBIGUOUS_UNIT: "AMBIGUOUS_UNIT",
  /** A value cannot be expressed in the requested unit without rounding. */
  LOSSY_CONVERSION: "LOSSY_CONVERSION",
  ...UNIT_ERROR_CODES,
});

// The ambiguous-unit rejection list is owned by lib/inventoryUnits.js and
// re-exported above; the adapter never invents a second copy.

const AMBIGUOUS_UNIT_SET = new Set(AMBIGUOUS_UNITS);

function fail(code, message, details) {
  throw new InventoryUnitError(code, message, details);
}

/**
 * Resolve a unit through the canonical vocabulary, rejecting missing and
 * ambiguous values first.
 *
 * @returns {Readonly<ReturnType<typeof normalizeUnit>>}
 */
function resolveAdapterUnit(unit, field = "unit") {
  if (unit == null) {
    fail(
      ADAPTER_ERROR_CODES.MISSING_UNIT,
      `${field} is required`,
      { field, unit }
    );
  }

  if (typeof unit === "string") {
    const trimmed = unit.trim();
    if (trimmed === "") {
      fail(
        ADAPTER_ERROR_CODES.MISSING_UNIT,
        `${field} must not be empty`,
        { field, unit }
      );
    }
    if (AMBIGUOUS_UNIT_SET.has(trimmed.toLowerCase())) {
      fail(
        ADAPTER_ERROR_CODES.AMBIGUOUS_UNIT,
        `${field} "${trimmed}" has no established dimension and cannot be converted`,
        {
          field,
          unit,
          reason: "Container/portion units are never inferred as a count or a volume",
          auditClass: "DIMENSION_UNKNOWN",
        }
      );
    }
  }

  // Unknown aliases, non-string units, internal spaces, and punctuation are
  // rejected by the canonical vocabulary itself.
  return normalizeUnit(unit, field);
}

function assertScaledQuantity(scaled, field = "scaled") {
  if (typeof scaled !== "bigint") {
    fail(
      UNIT_ERROR_CODES.INVALID_QUANTITY,
      `${field} must be a BigInt of canonical scaled units`,
      { field, value: scaled }
    );
  }
  if (scaled < 0n) {
    fail(
      UNIT_ERROR_CODES.NEGATIVE_QUANTITY,
      `${field} must not be negative`,
      { field, value: scaled.toString() }
    );
  }
  if (scaled > MAX_SCALED_QUANTITY) {
    fail(
      UNIT_ERROR_CODES.QUANTITY_OUT_OF_RANGE,
      `${field} exceeds the supported quantity bound`,
      { field, value: scaled.toString(), maxScaled: MAX_SCALED_QUANTITY.toString() }
    );
  }
  return scaled;
}

/**
 * Adapt one V1 (quantity, unit) pair to the canonical exact representation.
 *
 * The original values are returned untouched as `sourceQuantity` /
 * `sourceUnit`, including case and surrounding whitespace, so callers can keep
 * using them for audit and display. Nothing is normalized in place.
 *
 * @param {number|string} quantity V1 decimal quantity
 * @param {string} unit V1 free-text unit
 * @returns {Readonly<{
 *   dimension: "MASS"|"VOLUME"|"COUNT",
 *   canonicalUnit: "g"|"ml"|"pcs",
 *   approvedUnit: "kg"|"g"|"L"|"ml"|"pcs",
 *   scaled: bigint,
 *   scaledString: string,
 *   value: string,
 *   factorNumerator: bigint,
 *   factorDenominator: bigint,
 *   sourceQuantity: number|string,
 *   sourceUnit: string
 * }>}
 */
export function adaptV1Quantity(quantity, unit) {
  // Capture the originals before any validation, so a successful adaptation
  // proves the input was not rewritten.
  const sourceQuantity = quantity;
  const sourceUnit = unit;

  const definition = resolveAdapterUnit(unit);
  const canonical = toCanonicalQuantity(quantity, unit, "quantity");

  return Object.freeze({
    dimension: canonical.dimension,
    canonicalUnit: canonical.canonicalUnit,
    approvedUnit: definition.sourceUnit,
    scaled: canonical.scaled,
    scaledString: canonical.scaled.toString(),
    value: canonical.value,
    factorNumerator: definition.factorNumerator,
    factorDenominator: definition.factorDenominator,
    sourceQuantity,
    sourceUnit,
  });
}

/** Non-throwing probe, mirroring `canNormalizeUnit()` from Step 1. */
export function canAdaptV1Quantity(quantity, unit) {
  try {
    adaptV1Quantity(quantity, unit);
    return true;
  } catch {
    return false;
  }
}

/** Exact canonical decimal string for a scaled quantity (never rounded). */
export function formatCanonicalQuantity(scaled, field = "scaled") {
  const safeScaled = assertScaledQuantity(scaled, field);
  return formatScaledQuantity(safeScaled, { decimals: QTY_SCALE_DIGITS });
}

function assertAdaptedResult(result, field = "result") {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail(
      UNIT_ERROR_CODES.INVALID_QUANTITY,
      `${field} must be an adapted quantity object`,
      { field, value: result }
    );
  }
  if (typeof result.dimension !== "string") {
    fail(
      UNIT_ERROR_CODES.INVALID_QUANTITY,
      `${field}.dimension is required`,
      { field: `${field}.dimension` }
    );
  }
  if (typeof result.canonicalUnit !== "string") {
    fail(
      UNIT_ERROR_CODES.INVALID_QUANTITY,
      `${field}.canonicalUnit is required`,
      { field: `${field}.canonicalUnit` }
    );
  }
  if (typeof result.value !== "string") {
    fail(
      UNIT_ERROR_CODES.INVALID_QUANTITY,
      `${field}.value must be the exact canonical decimal string`,
      { field: `${field}.value`, value: result.value }
    );
  }
  if (typeof result.approvedUnit !== "string") {
    fail(
      UNIT_ERROR_CODES.INVALID_QUANTITY,
      `${field}.approvedUnit is required`,
      { field: `${field}.approvedUnit` }
    );
  }

  const safeScaled = assertScaledQuantity(result.scaled, `${field}.scaled`);
  const expectedValue = formatScaledQuantity(safeScaled, {
    decimals: QTY_SCALE_DIGITS,
  });

  // A display value that disagrees with the exact canonical quantity would
  // silently misrepresent it; refuse instead of preferring one of the two.
  if (result.value !== expectedValue) {
    fail(
      ADAPTER_ERROR_CODES.LOSSY_CONVERSION,
      `${field}.value does not match ${field}.scaled exactly`,
      {
        field: `${field}.value`,
        value: result.value,
        expectedValue,
        scaled: safeScaled.toString(),
      }
    );
  }

  return result;
}

/**
 * Express a canonical scaled quantity in a supported unit, exactly.
 *
 * This is the display/reverse helper. It rejects cross-dimension targets and
 * throws LOSSY_CONVERSION instead of rounding when the requested unit cannot
 * represent the canonical value exactly.
 */
export function formatInUnit(scaled, unit, field = "scaled") {
  const safeScaled = assertScaledQuantity(scaled, field);
  const target = resolveAdapterUnit(unit, "unit");
  const canonicalValue = formatScaledQuantity(safeScaled, {
    decimals: QTY_SCALE_DIGITS,
  });

  let converted;
  try {
    converted = convertQuantityExact(
      canonicalValue,
      target.canonicalUnit,
      target.sourceUnit
    );
  } catch (error) {
    if (
      error instanceof InventoryUnitError &&
      error.code === UNIT_ERROR_CODES.QUANTITY_PRECISION_UNSUPPORTED
    ) {
      fail(
        ADAPTER_ERROR_CODES.LOSSY_CONVERSION,
        `${field} cannot be expressed exactly in "${target.sourceUnit}"`,
        { field, unit, scaled: safeScaled.toString(), cause: error.code }
      );
    }
    throw error;
  }

  if (converted.scaled !== safeScaled) {
    fail(
      ADAPTER_ERROR_CODES.LOSSY_CONVERSION,
      `${field} did not round-trip exactly through "${target.sourceUnit}"`,
      {
        field,
        unit,
        scaled: safeScaled.toString(),
        roundTripScaled: converted.scaled.toString(),
      }
    );
  }

  return Object.freeze({
    unit: target.sourceUnit,
    canonicalUnit: target.canonicalUnit,
    dimension: target.dimension,
    scaled: safeScaled,
    value: converted.value,
  });
}

/**
 * Convert an adapted result to another unit in the same dimension.
 *
 * The original V1 values are carried through unchanged. Cross-dimension
 * conversions (g↔ml, pcs↔g, ...) are rejected, as are ambiguous/unknown target
 * units and any conversion that would lose precision.
 *
 * @returns {Readonly<{
 *   unit: string,
 *   canonicalUnit: "g"|"ml"|"pcs",
 *   dimension: string,
 *   scaled: bigint,
 *   value: string,
 *   sourceQuantity: number|string,
 *   sourceUnit: string
 * }>}
 */
export function convertAdaptedQuantity(result, targetUnit) {
  const safeResult = assertAdaptedResult(result);
  const target = resolveAdapterUnit(targetUnit, "targetUnit");

  if (target.dimension !== safeResult.dimension) {
    fail(
      UNIT_ERROR_CODES.UNIT_DIMENSION_MISMATCH,
      "Mass, volume, and count units cannot be converted across dimensions",
      {
        targetUnit,
        fromDimension: safeResult.dimension,
        toDimension: target.dimension,
      }
    );
  }

  const converted = formatInUnit(safeResult.scaled, targetUnit);

  return Object.freeze({
    unit: converted.unit,
    canonicalUnit: converted.canonicalUnit,
    dimension: converted.dimension,
    scaled: converted.scaled,
    value: converted.value,
    sourceQuantity: safeResult.sourceQuantity,
    sourceUnit: safeResult.sourceUnit,
  });
}

/**
 * Reverse an adapted result back to its original approved unit for display.
 *
 * Always exact for adapter-produced results; throws LOSSY_CONVERSION if a
 * value could not be represented without rounding.
 */
export function toSourceUnitQuantity(result) {
  const safeResult = assertAdaptedResult(result);
  return convertAdaptedQuantity(safeResult, safeResult.approvedUnit);
}
