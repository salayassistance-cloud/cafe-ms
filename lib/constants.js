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
  TELEBIRR: "TELEBIRR",
};

export const ORDER_STATUS = {
  PENDING: "PENDING",
  PREPARING: "PREPARING",
  READY: "READY",
  SERVED: "SERVED",
  CANCELLED: "CANCELLED",
};

export const ITEM_STATUS = {
  PENDING: "PENDING",
  PREPARING: "PREPARING",
  READY: "READY",
};

export const VALID_PAYMENT_STATUSES = Object.values(PAYMENT_STATUS);
export const VALID_PAYMENT_METHODS = Object.values(PAYMENT_METHOD);
export const VALID_ORDER_STATUSES = Object.values(ORDER_STATUS);
export const VALID_ITEM_STATUSES = Object.values(ITEM_STATUS);
