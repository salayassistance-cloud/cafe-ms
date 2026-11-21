// Central, strict Enums and Arrays for the Payment & Order lifecycle statuses.
// Single source of truth shared across services and models.

export const SITE_CONFIG = {
  name: "Hotel Management System",
  shortName: "Hotel System",
  portalTitle: "HOTEL MANAGEMENT SYSTEM • EXECUTIVE",
  description:
    "Next-Generation Enterprise Hotel Management & Digital Concierge System",
  footerText: "Hotel Management System • Executive POS",
};

export const PAYMENT_STATUS = {
  UNPAID: "UNPAID",
  PAID: "PAID",
  PENDING: "PENDING",
};

export const PAYMENT_METHOD = {
  NONE: "NONE",
  CASH: "CASH",
  TRANSFER: "TRANSFER",
  // Legacy brand kept for historical orders — active UI uses TRANSFER
  TELEBIRR: "TELEBIRR",
};

export const ORDER_STATUS = {
  PENDING: "PENDING",
  PREPARING: "PREPARING",
  READY: "READY",
  SERVED: "SERVED",
  PAYMENT_PENDING: "PAYMENT_PENDING",
  PAID: "PAID",
  CANCELLED: "CANCELLED",
  ARCHIVED: "ARCHIVED",
};

export const ITEM_STATUS = {
  PENDING: "PENDING",
  PREPARING: "PREPARING",
  READY: "READY",
  CANCELLED: "CANCELLED",
};

export const VALID_PAYMENT_STATUSES = Object.values(PAYMENT_STATUS);
export const VALID_PAYMENT_METHODS = Object.values(PAYMENT_METHOD);
export const VALID_ORDER_STATUSES = Object.values(ORDER_STATUS);
export const VALID_ITEM_STATUSES = Object.values(ITEM_STATUS);

// Canonical lifecycle split — single source of truth for "terminal" orders.
//
// SERVED and PAYMENT_PENDING are terminal for editing and for inventory-policy
// classification: the order can no longer be edited (lib/orderService.js
// updateOrderStatus / editOrderItems guards) and its lines carry immutable
// Phase 1 policy/Recipe snapshots. PAID, CANCELLED and ARCHIVED are the
// remaining terminal states. Everything else is an open ticket.
//
// Previously each service carried its own inline array; this helper replaces
// those duplicates without changing their verified behavior.
export const TERMINAL_ORDER_STATUSES = Object.freeze(
  [
    ORDER_STATUS.SERVED,
    ORDER_STATUS.PAYMENT_PENDING,
    ORDER_STATUS.PAID,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.ARCHIVED,
  ].filter((status) => VALID_ORDER_STATUSES.includes(status))
);
export const OPEN_ORDER_STATUSES = Object.freeze(
  VALID_ORDER_STATUSES.filter((status) => !TERMINAL_ORDER_STATUSES.includes(status))
);

export function isTerminalOrderStatus(status) {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function isOpenOrderStatus(status) {
  return OPEN_ORDER_STATUSES.includes(status);
}
