// BONO Inventory V2 — exact quantity representation.
//
// Canonical representation
// ------------------------
// An exact quantity is:
//
//   { unit, canonicalUnit, scaled }
//
// where `scaled` is a BigInt in *canonical base units* (g, ml, pcs) at a fixed
// scale of 10^6. Examples:
//
//   0.1 g      -> scaled = 100_000n
//   0.4 g      -> scaled = 400_000n
//   0.5 g      -> scaled = 500_000n
//   1.2345 g   -> scaled = 1_234_500n
//   0.0001 kg  -> scaled = 100_000n
//
// `scaled` is the single accounting source of truth. Binary floating point is
// never used for accounting comparisons, equations, or transitions. Numbers are
// accepted only at the input/display boundary and are parsed from their exact
// decimal string form.
//
// Precision
// ---------
// Supported precision is 6 decimal places in a canonical base unit. For source
// units that are 1000× larger (kg, L) the parser accepts 9 decimal places, so
// every canonical value round-trips exactly through kg/L. Values that cannot be
// represented exactly are rejected with QUANTITY_PRECISION_UNSUPPORTED; they are
// never rounded, inflated, reduced, or converted to zero.
//
// Technical bound
// ---------------
// |scaled| <= 10^14 (100,000,000 canonical units, e.g. 100,000 kg).
//
// This is a representation/safety bound, not a business maximum. It keeps every
// 6-decimal value at or below 15 significant decimal digits so the display
// projection round-trips through a JS Number without changing the value, and it
// bounds BigInt work. Values outside the bound are rejected with
// QUANTITY_OUT_OF_RANGE, never clamped.
//
// Display formatting
// ------------------
// Numeric projections returned by legacy helpers are display-only. Exact
// comparisons always use the scaled BigInt values.

import {
  ERROR_CODES,
  fail,
} from "./errors.js";

export const QTY_SCALE_DIGITS = 6;
export const QTY_SCALE = 1_000_000n;

// 10^14 scaled units = 100,000,000 canonical units. See the bound notes above.
export const MAX_SCALED_QUANTITY = 100_000_000_000_000n;

export const EXACT_QUANTITY_ERRORS = Object.freeze({
  QUANTITY_PRECISION_UNSUPPORTED: "QUANTITY_PRECISION_UNSUPPORTED",
  QUANTITY_OUT_OF_RANGE: "QUANTITY_OUT_OF_RANGE",
});

const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const MAX_DECIMAL_TEXT_LENGTH = 64;
const MAX_EXPONENT_MAGNITUDE = 1000;

function valueToDecimalString(value, field) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(ERROR_CODES.INVALID_QUANTITY, `${field} must be a finite number`, {
        field,
        value,
      });
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (value.length === 0 || value.trim() !== value) {
      fail(
        ERROR_CODES.INVALID_QUANTITY,
        `${field} must be a non-empty decimal string without surrounding whitespace`,
        { field, value }
      );
    }
    if (value.length > MAX_DECIMAL_TEXT_LENGTH) {
      fail(
        EXACT_QUANTITY_ERRORS.QUANTITY_OUT_OF_RANGE,
        `${field} decimal text is too long`,
        { field, length: value.length, maxLength: MAX_DECIMAL_TEXT_LENGTH }
      );
    }
    return value;
  }
  fail(
    ERROR_CODES.INVALID_QUANTITY,
    `${field} must be a number or decimal string`,
    { field, value }
  );
}

function assertScaledBigInt(
  scaled,
  field,
  { allowNegative = false, max = MAX_SCALED_QUANTITY } = {}
) {
  if (typeof scaled !== "bigint") {
    fail(ERROR_CODES.INVALID_QUANTITY, `${field} must be a BigInt`, {
      field,
      value: scaled,
    });
  }
  if (!allowNegative && scaled < 0n) {
    fail(ERROR_CODES.NEGATIVE_QUANTITY, `${field} must not be negative`, {
      field,
      value: scaled.toString(),
    });
  }
  if (scaled > max || scaled < -max) {
    fail(
      EXACT_QUANTITY_ERRORS.QUANTITY_OUT_OF_RANGE,
      `${field} exceeds the supported quantity bound`,
      {
        field,
        value: scaled.toString(),
        maxScaled: max.toString(),
      }
    );
  }
  return scaled === 0n ? 0n : scaled;
}

/**
 * Parse a decimal value into canonical scaled units.
 *
 * `decimals` is the number of decimal places in the *input* unit that map to one
 * canonical scaled unit. Canonical base units use 6; larger units such as kg and
 * L use 9 because 1e-9 kg = 1e-6 g = 1 scaled unit.
 */
export function parseScaledQuantity(
  value,
  field = "quantity",
  {
    allowNegative = false,
    max = MAX_SCALED_QUANTITY,
    decimals = QTY_SCALE_DIGITS,
  } = {}
) {
  if (typeof value === "bigint") {
    return assertScaledBigInt(value, field, { allowNegative, max });
  }
  if (value && typeof value === "object") {
    if (typeof value.scaled === "bigint") {
      return assertScaledBigInt(value.scaled, field, { allowNegative, max });
    }
    fail(
      ERROR_CODES.INVALID_QUANTITY,
      `${field} exact object must contain a BigInt scaled value`,
      { field, value }
    );
  }

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    fail(ERROR_CODES.INVALID_INPUT, "decimals must be an integer 0..18", {
      decimals,
    });
  }

  const text = valueToDecimalString(value, field);
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    fail(ERROR_CODES.INVALID_QUANTITY, `${field} is not a decimal value`, {
      field,
      value,
    });
  }

  const sign = match[1];
  const integerPart = match[2] || "";
  const fractionPart = match[3] || "";
  const exponentText = match[4] === undefined ? "0" : match[4];

  if (integerPart.length === 0 && fractionPart.length === 0) {
    fail(ERROR_CODES.INVALID_QUANTITY, `${field} has no digits`, {
      field,
      value,
    });
  }

  const exponent = Number(exponentText);
  if (
    !Number.isSafeInteger(exponent) ||
    Math.abs(exponent) > MAX_EXPONENT_MAGNITUDE
  ) {
    fail(
      EXACT_QUANTITY_ERRORS.QUANTITY_OUT_OF_RANGE,
      `${field} exponent is outside the supported range`,
      { field, value, maxExponentMagnitude: MAX_EXPONENT_MAGNITUDE }
    );
  }

  const digits = `${integerPart}${fractionPart}`;
  const shift = exponent - fractionPart.length + decimals;

  let scaled = BigInt(digits);
  if (shift >= 0) {
    if (shift > 64) {
      fail(
        EXACT_QUANTITY_ERRORS.QUANTITY_OUT_OF_RANGE,
        `${field} would exceed the supported quantity bound`,
        { field, value }
      );
    }
    scaled *= 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    if (scaled % divisor !== 0n) {
      fail(
        EXACT_QUANTITY_ERRORS.QUANTITY_PRECISION_UNSUPPORTED,
        `${field} has more precision than the exact representation supports`,
        {
          field,
          value,
          maxDecimals: decimals,
        }
      );
    }
    scaled /= divisor;
  }

  if (sign === "-") scaled = -scaled;
  return assertScaledBigInt(scaled, field, { allowNegative, max });
}

export function assertScaledQuantity(value, field = "quantity") {
  return parseScaledQuantity(value, field);
}

export function assertSignedScaledQuantity(value, field = "quantity") {
  return parseScaledQuantity(value, field, { allowNegative: true });
}

export function assertPositiveScaledQuantity(value, field = "quantity") {
  const scaled = parseScaledQuantity(value, field);
  if (scaled === 0n) {
    fail(ERROR_CODES.INVALID_QUANTITY, `${field} must be strictly positive`, {
      field,
      value,
    });
  }
  return scaled;
}

/**
 * Legacy numeric validator. Returns a display projection only; the exact
 * accounting value must be obtained through assertScaledQuantity().
 */
export function assertQuantity(value, field = "quantity") {
  return scaledToNumber(assertScaledQuantity(value, field));
}

/**
 * Legacy signed numeric validator for display-only callers. See
 * assertSignedScaledQuantity() for the exact value.
 */
export function assertSignedQuantity(value, field = "quantity") {
  return scaledToNumber(assertSignedScaledQuantity(value, field));
}

export function assertNonNegativeInteger(
  value,
  field = "value",
  { min = 0 } = {}
) {
  if (!Number.isSafeInteger(value) || value < min) {
    fail(ERROR_CODES.INVALID_INPUT, `${field} must be a safe integer >= ${min}`, {
      field,
      value,
      min,
    });
  }
  return value;
}

export function assertPositiveInteger(value, field = "value") {
  return assertNonNegativeInteger(value, field, { min: 1 });
}

/** Format a canonical scaled BigInt as an exact decimal string. */
export function formatScaledQuantity(
  scaled,
  { decimals = QTY_SCALE_DIGITS, trim = true } = {}
) {
  if (typeof scaled !== "bigint") {
    fail(ERROR_CODES.INVALID_QUANTITY, "quantity must be a BigInt", {
      value: scaled,
    });
  }
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const factor = 10n ** BigInt(decimals);
  const whole = absolute / factor;
  const remainder = (absolute % factor).toString().padStart(decimals, "0");
  const fraction = trim ? remainder.replace(/0+$/, "") : remainder;
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Display-only projection; never use for accounting comparisons. */
export function scaledToNumber(scaled) {
  return Number(formatScaledQuantity(scaled));
}

export function addScaledQuantities(...values) {
  let sum = 0n;
  for (const value of values) {
    const scaled = assertScaledBigInt(value, "quantity", {
      allowNegative: true,
    });
    sum += scaled;
  }
  return assertScaledBigInt(sum, "quantity", { allowNegative: true });
}

export function subtractScaledQuantities(a, b) {
  const left = assertScaledBigInt(a, "quantity", { allowNegative: true });
  const right = assertScaledBigInt(b, "quantity", { allowNegative: true });
  return assertScaledBigInt(left - right, "quantity", { allowNegative: true });
}

export function compareScaledQuantities(a, b) {
  const left = assertScaledBigInt(a, "quantity", { allowNegative: true });
  const right = assertScaledBigInt(b, "quantity", { allowNegative: true });
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function scaledQuantitiesEqual(a, b) {
  return compareScaledQuantities(a, b) === 0;
}

/**
 * Exact equality. The second argument is retained for call-site compatibility;
 * no epsilon is applied anywhere in the accounting path.
 */
export function nearlyEqual(a, b) {
  try {
    return (
      assertSignedScaledQuantity(a, "left") ===
      assertSignedScaledQuantity(b, "right")
    );
  } catch {
    return false;
  }
}

/** Display-only legacy helper. Accounting code must not call this. */
export function round3(value) {
  const scaled = assertSignedScaledQuantity(value, "quantity");
  const drop = QTY_SCALE_DIGITS - 3;
  const factor = 10n ** BigInt(drop);
  const absolute = scaled < 0n ? -scaled : scaled;
  const quotient = absolute / factor;
  const remainder = absolute % factor;
  const roundedAbsolute = remainder * 2n >= factor ? quotient + 1n : quotient;
  const rounded = scaled < 0n ? -roundedAbsolute : roundedAbsolute;
  return scaledToNumber(rounded * factor);
}

/** Legacy display-only addition. */
export function addQuantities(...values) {
  return scaledToNumber(
    addScaledQuantities(
      ...values.map((value) => assertSignedScaledQuantity(value, "quantity"))
    )
  );
}

/** Legacy display-only subtraction. */
export function subtractQuantities(a, b) {
  return scaledToNumber(
    subtractScaledQuantities(
      assertSignedScaledQuantity(a, "left"),
      assertSignedScaledQuantity(b, "right")
    )
  );
}
