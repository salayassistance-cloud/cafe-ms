// BONO Inventory V2 — shared state vocabulary.
//
// This module is pure: constants only. Inventory state is deliberately kept
// separate from KDS preparation state. No Order/KDS field is created here.

export const CANONICAL_STATIONS = Object.freeze([
  "KITCHEN",
  "BARISTA",
  "HOT_DRINK",
]);

export const INVENTORY_STATES = Object.freeze({
  NOT_APPLICABLE: "NOT_APPLICABLE",
  PENDING: "PENDING",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  APPROVED: "APPROVED",
  // Recovery/legacy-only. Never a committed happy-path state in Model A.
  CONSUMING: "CONSUMING",
  CONSUMED: "CONSUMED",
  PARTIALLY_CONSUMED: "PARTIALLY_CONSUMED",
  RECOVERY_REQUIRED: "RECOVERY_REQUIRED",
  RELEASED: "RELEASED",
  RELEASED_PARTIAL: "RELEASED_PARTIAL",
});

export const INVENTORY_STATE_VALUES = Object.freeze(
  Object.values(INVENTORY_STATES)
);

export const KDS_STATES = Object.freeze({
  PENDING: "PENDING",
  PREPARING: "PREPARING",
  READY: "READY",
});

export const KDS_STATE_VALUES = Object.freeze(Object.values(KDS_STATES));

// PARTIALLY_CONSUMED in the first release has exactly one meaning.
export const COMPLETION_REASONS = Object.freeze({
  FULL: "FULL",
  APPROVED_SHORTAGE: "APPROVED_SHORTAGE",
  PREPARED_UNSOLD: "PREPARED_UNSOLD",
  POST_START_CANCELLED: "POST_START_CANCELLED",
});

export const TERMINAL_INVENTORY_STATES = Object.freeze([
  INVENTORY_STATES.RELEASED,
  INVENTORY_STATES.RELEASED_PARTIAL,
]);

// States that still own a live allocation / possible hold.
export const ACTIVE_INVENTORY_STATES = Object.freeze([
  INVENTORY_STATES.PENDING,
  INVENTORY_STATES.APPROVAL_REQUIRED,
  INVENTORY_STATES.APPROVED,
  INVENTORY_STATES.CONSUMING,
  INVENTORY_STATES.CONSUMED,
  INVENTORY_STATES.PARTIALLY_CONSUMED,
  INVENTORY_STATES.RECOVERY_REQUIRED,
]);

export const WASTE_CLASSES = Object.freeze({
  ORDER_LINKED: "ORDER_LINKED",
  PREPARED_UNSOLD: "PREPARED_UNSOLD",
  DIRECT: "DIRECT",
});

export function isCanonicalStation(value) {
  return CANONICAL_STATIONS.includes(String(value || "").toUpperCase());
}

export function isInventoryState(value) {
  return INVENTORY_STATE_VALUES.includes(String(value || "").toUpperCase());
}

export function isTerminalInventoryState(value) {
  return TERMINAL_INVENTORY_STATES.includes(String(value || "").toUpperCase());
}
