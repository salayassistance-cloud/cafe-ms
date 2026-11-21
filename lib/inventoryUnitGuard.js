// inventoryUnitGuard.js — write-boundary enforcement for the canonical unit
// vocabulary.
//
// This module intentionally contains NO vocabulary of its own. It is a thin
// classification layer over the existing authoritative V1 unit module, which
// owns both the accepted alias table/factors and the explicit ambiguous-unit
// rejection list shared with the adapter.
//
// It does not convert, alias, rewrite, or guess a unit. It only answers:
//
//   valid      — an approved alias (canonical base or exact kg/L multiple)
//   ambiguous  — a container/portion noun (cup, bottle, can, pack, ...)
//   unknown    — not in the approved vocabulary
//   missing    — null/undefined/blank
//
// Callers reject anything that is not `valid`. A valid alias is persisted as the
// caller supplied it (trimmed): the canonical engine already maps it at
// conversion time, and this module never silently rewrites stored units.

import { AMBIGUOUS_UNITS, UNIT_DEFINITIONS, normalizeUnit } from "./inventoryUnits.js";

// Stable HTTP-facing code. The reservation layer keeps its own more specific
// codes (MISSING_UNIT / AMBIGUOUS_UNIT / UNKNOWN_UNIT); write paths expose
// INVALID_UNIT so clients have one predictable business code.
export const INVALID_UNIT_CODE = "INVALID_UNIT";

const AMBIGUOUS_UNIT_SET = new Set(AMBIGUOUS_UNITS);

// Display order for controlled selects. Values are the approved V1 unit labels
// from the existing engine (not a second vocabulary): g, kg, ml, L, pcs.
const OPTION_LABELS = Object.freeze({
  g: "g — gram",
  kg: "kg — kilogram",
  ml: "ml — millilitre",
  L: "L — litre",
  pcs: "pcs — each / piece",
});

export const INVENTORY_UNIT_OPTIONS = Object.freeze(
  Object.keys(UNIT_DEFINITIONS).map((value) =>
    Object.freeze({ value, label: OPTION_LABELS[value] || value })
  )
);

export const INVENTORY_UNIT_VALUES = Object.freeze(
  INVENTORY_UNIT_OPTIONS.map((option) => option.value)
);

function result(status, code, unit, extra = {}) {
  return Object.freeze({
    status,
    code,
    input: unit,
    canonicalUnit: null,
    sourceUnit: null,
    dimension: null,
    ...extra,
  });
}

/**
 * Classify a unit without throwing.
 *
 * @param {unknown} unit
 * @returns {Readonly<{
 *   status: "valid"|"ambiguous"|"unknown"|"missing",
 *   code: string|null,
 *   input: unknown,
 *   canonicalUnit: string|null,
 *   sourceUnit: string|null,
 *   dimension: string|null
 * }>}
 */
export function classifyInventoryUnit(unit) {
  if (unit == null) {
    return result("missing", "MISSING_UNIT", unit);
  }
  if (typeof unit !== "string") {
    return result("unknown", "UNKNOWN_UNIT", unit);
  }
  const trimmed = unit.trim();
  if (!trimmed) {
    return result("missing", "MISSING_UNIT", unit);
  }
  if (AMBIGUOUS_UNIT_SET.has(trimmed.toLowerCase())) {
    // Container/portion nouns are never interpreted as pcs.
    return result("ambiguous", "AMBIGUOUS_UNIT", unit);
  }
  try {
    const definition = normalizeUnit(trimmed);
    return result("valid", null, unit, {
      canonicalUnit: definition.canonicalUnit,
      sourceUnit: definition.sourceUnit,
      dimension: definition.dimension,
      value: trimmed,
    });
  } catch {
    // The engine rejects every non-alias as UNKNOWN_UNIT; anything else would be
    // an engine defect and is still surfaced as an unknown unit, not accepted.
    return result("unknown", "UNKNOWN_UNIT", unit);
  }
}

function invalidMessage(field, unit, code) {
  if (code === "MISSING_UNIT") return `${field} is required`;
  if (code === "AMBIGUOUS_UNIT") {
    return `${field} "${String(unit)}" is ambiguous; use an exact unit (g, kg, ml, L, or pcs)`;
  }
  return `${field} "${String(unit)}" is not a supported inventory unit; use g, kg, ml, L, or pcs`;
}

/**
 * Validate a unit for persistence.
 *
 * @param {unknown} unit
 * @param {string} [field]
 * @returns {{ok: true, value: string, canonicalUnit: string, sourceUnit: string, dimension: string, code: null}
 *   | {ok: false, code: string, error: string}}
 */
export function validateInventoryUnit(unit, field = "unit") {
  const classified = classifyInventoryUnit(unit);
  if (classified.status === "valid") {
    return {
      ok: true,
      value: classified.value,
      canonicalUnit: classified.canonicalUnit,
      sourceUnit: classified.sourceUnit,
      dimension: classified.dimension,
      code: null,
    };
  }
  const code = classified.code || INVALID_UNIT_CODE;
  return {
    ok: false,
    code,
    error: invalidMessage(field, unit, code),
  };
}

export function isValidInventoryUnit(unit) {
  return classifyInventoryUnit(unit).status === "valid";
}
