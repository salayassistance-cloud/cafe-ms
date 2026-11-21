// inventoryReservationRules.js — pure, dependency-free helpers for the
// pre-preparation inventory reservation layer.
//
// Kept separate from inventoryReservationService.js so the allocation and
// fingerprint rules can be unit-tested without MongoDB or module-alias
// resolution. No database access, no side effects.

import crypto from "crypto";

export const QTY_EPSILON = 1e-9;

export function round3(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1000) / 1000;
}

export function normalizeUnit(value) {
  return String(value || "").trim().toLowerCase();
}

// H-2: one Recipe activation rule for every reader.
// Only an explicit `false` is inactive; `true`, missing, and legacy `undefined`
// are active. `isRecipeActive` is the document predicate used by deduction
// selection; RECIPE_ACTIVE_FILTER is the equivalent MongoDB query used by the
// D2 unit-change guard, so the two can never drift apart.
export function isRecipeActive(recipe) {
  return recipe?.isActive !== false;
}

export const RECIPE_ACTIVE_FILTER = Object.freeze({ isActive: { $ne: false } });

export function sameUnit(a, b) {
  const ua = normalizeUnit(a);
  const ub = normalizeUnit(b);
  return !!ua && ua === ub;
}

// Sellable right now. Defensive against legacy items without reservedStock.
export function availableOf(doc) {
  const current = Number(doc?.currentStock);
  const reserved = Number(doc?.reservedStock);
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safeReserved = Number.isFinite(reserved) ? reserved : 0;
  return Math.max(0, safeCurrent - safeReserved);
}

// The single allocation rule used by initial reservation, reconciliation and
// approval. `held` is already part of reservedStock; `available` is the net
// sellable quantity. Returns how much of `required` is covered by holds plus
// still-available stock, and the remaining shortage.
export function planCoverage(requiredQuantity, heldQuantity, availableQuantity) {
  const required = Math.max(0, round3(requiredQuantity));
  const held = Math.max(0, round3(heldQuantity));
  const available = Math.max(0, round3(availableQuantity));
  const reservedQuantity = round3(Math.min(required, held + available));
  return {
    requiredQuantity: required,
    reservedQuantity,
    shortageQuantity: Math.max(0, round3(required - reservedQuantity)),
  };
}

// A reservation is "consumed" once physical stock has been decremented for it.
// This is the lifecycle decision point used by cancellation: consumed stock is
// never returned to availability, it is recorded as a void/waste instead.
export function hasConsumedStock(reservation) {
  if (!reservation) return false;
  if (String(reservation.status || "") === "CONSUMING") return true;
  if (String(reservation.status || "") === "CONSUMED") return true;
  if (reservation.consumedAt) return true;
  return (Array.isArray(reservation.items) ? reservation.items : []).some(
    (it) => round3(it?.consumedQuantity) > QTY_EPSILON
  );
}

// What a cancellation/archive must do to inventory. Before preparation the
// hold is returned. After preparation the stock is already physically gone, so
// the only correct action is an auditable void (and, for a whole-order
// cancellation, reclassifying the sale movements as waste).
export function releasePlan(reservation, { source = "ORDER", recordVoid = true } = {}) {
  const consumed = hasConsumedStock(reservation);
  if (!consumed) {
    return {
      action: "RELEASE_HOLDS",
      phase: "BEFORE_PREPARATION",
      recordVoid: false,
      reclassifyMovements: false,
    };
  }
  return {
    action: "VOID_CONSUMED",
    phase: "AFTER_PREPARATION",
    recordVoid: recordVoid !== false,
    reclassifyMovements: recordVoid !== false && String(source).toUpperCase() === "ORDER",
  };
}

// Consumption is claimed exactly once. A repeated preparation start or a
// payment retry must observe one of these states and skip the stock write.
export function consumptionPlan(status) {
  const s = String(status || "").toUpperCase();
  if (s === "CONSUMED") return "ALREADY_CONSUMED";
  if (s === "CONSUMING") return "IN_PROGRESS";
  if (s === "RELEASED") return "RELEASED";
  return "CONSUME";
}

export function buildRequirementFingerprint(orderId, items) {
  const rows = (Array.isArray(items) ? items : [])
    .map((it) => ({
      id: String(it.inventoryItemId || ""),
      unit: normalizeUnit(it.unit),
      qty: round3(it.requiredQuantity ?? it.quantity),
    }))
    .filter((it) => it.id && it.qty > 0)
    .sort((a, b) => `${a.id}:${a.unit}`.localeCompare(`${b.id}:${b.unit}`))
    .map((it) => `${it.id}:${it.unit}:${it.qty.toFixed(3)}`)
    .join("|");
  return crypto.createHash("sha256").update(`${String(orderId)}|${rows}`).digest("hex");
}

export function buildShortageFingerprint(requirementFingerprint, items) {
  const rows = (Array.isArray(items) ? items : [])
    .map((it) => ({
      id: String(it.inventoryItemId || ""),
      unit: normalizeUnit(it.unit),
      required: round3(it.requiredQuantity),
      available: round3(it.availableAtDecision),
      shortage: round3(it.shortageQuantity),
    }))
    .filter((it) => it.id)
    .sort((a, b) => `${a.id}:${a.unit}`.localeCompare(`${b.id}:${b.unit}`))
    .map(
      (it) =>
        `${it.id}:${it.unit}:${it.required.toFixed(3)}:${it.available.toFixed(3)}:${it.shortage.toFixed(3)}`
    )
    .join("|");
  return crypto
    .createHash("sha256")
    .update(`${String(requirementFingerprint || "")}|${rows}`)
    .digest("hex");
}
