// inventoryRequirementConversion.js — pure, offline V1 requirement boundary.
//
// PURPOSE
// -------
// Convert one V1 demand (quantity, unit) into the InventoryItem's stock unit
// using the existing canonical unit engine and the fail-closed adapter, then
// merge validated requirements deterministically per inventory item.
//
// This module is deliberately standalone:
//   - no database, Mongoose, environment, or application-runtime import;
//   - relative imports only, so plain `node --test` can load it;
//   - no side effects at import time.
//
// APPROVED POLICY (docs/inventory-unit-owner-decisions.md)
// --------------------------------------------------------
// M3: convert exactly into the item's stock unit first, then merge per item.
// M4: no new aliases. Unknown/ambiguous units fail closed. Identical unit text
//     keeps V1 behavior in the service fast path for *approved* aliases only;
//     an unambiguous list (cup, bottle, can, pack, ...) is rejected even when
//     both sides share the same free text.
// M5: V1 supports three decimal places. A converted value that is not an exact
//     multiple of 0.001 stock unit is rejected, never rounded.

import {
  AMBIGUOUS_UNITS,
  QTY_SCALE,
  isInventoryUnitError,
  normalizeUnit,
  toCanonicalQuantity,
} from "./inventoryUnits.js";
import {
  ADAPTER_ERROR_CODES,
  adaptV1Quantity,
  convertAdaptedQuantity,
} from "./inventoryUnitAdapter.js";

const MILLI = 1000n;
const MAX_SAFE_MILLI = BigInt(Number.MAX_SAFE_INTEGER);
const AMBIGUOUS_UNIT_SET = new Set(AMBIGUOUS_UNITS);

function failure(code) {
  return Object.freeze({ ok: false, quantity: null, quantityMilli: null, code });
}

function codeOf(error) {
  return typeof error?.code === "string" ? error.code : ADAPTER_ERROR_CODES.INVALID_QUANTITY;
}

/**
 * Canonical scaled units contained in 0.001 of `definition`'s unit.
 *
 * `scaled` is canonical at 1e-6, so 0.001 stock unit is
 * `1e-3 * factorNumerator / factorDenominator` canonical units, i.e.
 * `(QTY_SCALE * factorNumerator) / (factorDenominator * 1000)` scaled units.
 * All factors are exact powers of ten, so the result is an exact integer.
 */
function milliScaleOf(definition) {
  const divisor = definition.factorDenominator * MILLI;
  if (divisor === 0n) return null;
  const product = QTY_SCALE * definition.factorNumerator;
  if (product % divisor !== 0n) return null;
  const scale = product / divisor;
  return scale > 0n ? scale : null;
}

/**
 * Convert a V1 requirement quantity from its demand unit into the stock unit.
 *
 * @param {number|string} requiredQuantity V1 three-decimal quantity
 * @param {string} demandUnit recipe/component unit (free text)
 * @param {string} stockUnit InventoryItem.unit
 * @returns {Readonly<
 *   | { ok: true, quantity: number, quantityMilli: bigint, code: null }
 *   | { ok: false, quantity: null, quantityMilli: null, code: string }
 * >} `quantityMilli` is an exact integer count of 0.001 stock units.
 */
export function convertRequirementToStockUnit(requiredQuantity, demandUnit, stockUnit) {
  try {
    // The adapter validates the demand unit (missing/ambiguous/unknown),
    // the quantity (finite, non-negative, exact at 1e-6, in range) and the
    // target unit (missing/ambiguous/unknown) before any conversion.
    const adapted = adaptV1Quantity(requiredQuantity, demandUnit);
    const converted = convertAdaptedQuantity(adapted, stockUnit);

    // Verified contract: normalizeUnit returns exact power-of-ten factors.
    const definition = normalizeUnit(stockUnit, "stockUnit");
    const milliScale = milliScaleOf(definition);
    if (milliScale === null) {
      return failure(ADAPTER_ERROR_CODES.INVALID_QUANTITY);
    }

    // Exact representability at V1's three decimals. BigInt only: a value that
    // does not divide evenly is rejected, never rounded into range.
    if (converted.scaled % milliScale !== 0n) {
      return failure(ADAPTER_ERROR_CODES.LOSSY_CONVERSION);
    }

    const quantityMilli = converted.scaled / milliScale;
    if (quantityMilli <= 0n) {
      return failure(ADAPTER_ERROR_CODES.INVALID_QUANTITY);
    }
    if (quantityMilli > MAX_SAFE_MILLI) {
      return failure(ADAPTER_ERROR_CODES.QUANTITY_OUT_OF_RANGE);
    }

    return Object.freeze({
      ok: true,
      quantity: Number(quantityMilli) / 1000,
      quantityMilli,
      code: null,
    });
  } catch (error) {
    if (isInventoryUnitError(error)) return failure(codeOf(error));
    throw error;
  }
}

/**
 * Merge validated requirements deterministically per inventory item.
 *
 * Rows must already carry their stock unit (this module's conversion output or
 * V1's same-unit fast path). Merging is keyed by inventory item *and* the
 * normalized unit, so incompatible dimensions or unresolved units are never
 * combined even if a caller passes them together.
 *
 * Summing is exact: every row is re-parsed into integer milli-units through the
 * canonical engine, so no floating-point accumulation drift is possible.
 *
 * @param {Array<{inventoryItemId:string, unit:string, requiredQuantity:number}>} items
 * @returns {{items: Array<object>, warnings: string[]}}
 */
export function mergeRequirements(items) {
  const warnings = [];
  const groups = new Map();
  const rows = Array.isArray(items) ? items : [];

  for (const row of rows) {
    const inventoryItemId = String(row?.inventoryItemId || "");
    if (!inventoryItemId) {
      warnings.push(
        `Inventory requirement has no inventory item reference — no reservation (${ADAPTER_ERROR_CODES.INVALID_QUANTITY})`
      );
      continue;
    }

    const unit = typeof row?.unit === "string" ? row.unit : String(row?.unit ?? "");
    // The same-unit fast path must not accept an ambiguous container/portion
    // noun merely because both sides share the text (cup/cup, bottle/bottle).
    // This is the write/merge-time mirror of the adapter's rejection list.
    if (AMBIGUOUS_UNIT_SET.has(unit.trim().toLowerCase())) {
      warnings.push(
        `Inventory requirement for item ${inventoryItemId} uses ambiguous unit ${
          unit || "(missing)"
        } — no reservation (${ADAPTER_ERROR_CODES.AMBIGUOUS_UNIT})`
      );
      continue;
    }
    let definition;
    let scaled;
    try {
      definition = normalizeUnit(unit, "unit");
      scaled = toCanonicalQuantity(row?.requiredQuantity, unit, "requiredQuantity").scaled;
    } catch (error) {
      if (!isInventoryUnitError(error)) throw error;
      warnings.push(
        `Inventory requirement for item ${inventoryItemId} with unit ${
          unit || "(missing)"
        } cannot be validated — no reservation (${codeOf(error)})`
      );
      continue;
    }

    const milliScale = milliScaleOf(definition);
    if (milliScale === null || scaled % milliScale !== 0n) {
      warnings.push(
        `Inventory requirement for item ${inventoryItemId} in ${unit} is not exactly representable at three decimals — no reservation (${ADAPTER_ERROR_CODES.QUANTITY_PRECISION_UNSUPPORTED})`
      );
      continue;
    }

    const milli = scaled / milliScale;
    if (milli <= 0n) {
      warnings.push(
        `Inventory requirement for item ${inventoryItemId} in ${unit} has no positive quantity — no reservation (${ADAPTER_ERROR_CODES.INVALID_QUANTITY})`
      );
      continue;
    }

    const key = `${inventoryItemId}::${definition.sourceUnit}`;
    const group = groups.get(key);
    if (group) {
      group.milli += milli;
      // Deterministic label choice independent of source row order.
      if (unit < group.unit) group.unit = unit;
    } else {
      groups.set(key, { template: row, inventoryItemId, unit, milli });
    }
  }

  const merged = [];
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const group = groups.get(key);
    if (group.milli > MAX_SAFE_MILLI) {
      warnings.push(
        `Merged inventory requirement for item ${group.inventoryItemId} exceeds the supported quantity bound — no reservation (${ADAPTER_ERROR_CODES.QUANTITY_OUT_OF_RANGE})`
      );
      continue;
    }
    merged.push({
      ...group.template,
      inventoryItemId: group.inventoryItemId,
      unit: group.unit,
      requiredQuantity: Number(group.milli) / 1000,
    });
  }

  return { items: merged, warnings };
}
