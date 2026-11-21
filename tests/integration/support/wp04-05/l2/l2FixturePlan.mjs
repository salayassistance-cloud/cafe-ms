// WP04-05 L2 — synthetic V1 D01–D10 fixture plan (TEST-ONLY, data only).
//
// The plan is a pure data module. It contains no connection, no writer and no
// side effect beyond building frozen objects. `l2FixtureSeeder.mjs` is the only
// module allowed to insert these documents, and only into a newly created
// disposable `bono_recovery_wp04_05_*` database.
//
// Fixture design
// --------------
// One order per D01–D10 rule (plus the minimum reservations/movements needed to
// reach the rule). Fields mirror the real V1 collections consumed by
// `lib/recovery/adapter.js`:
//   orders                 -> orders
//   inventory reservations -> inventoryreservations
//   stock movements        -> stockmovements
//   inventory items        -> inventoryitems
// No production index is created. The fixtures intentionally represent legacy
// and malformed states (duplicate sale keys, missing payment timestamps,
// negative quantity) that D01–D10 exist to detect.
//
// Every timestamps is a real Date inside WINDOW because V1 uses Mongoose
// `timestamps: true` (Date fields), not ISO strings.

import { ObjectId } from "bson";

export const COLLECTIONS = Object.freeze({
  orders: "orders",
  reservations: "inventoryreservations",
  movements: "stockmovements",
  inventory: "inventoryitems",
});

export const WINDOW = Object.freeze({
  since: "2026-11-10T00:00:00.000Z",
  until: "2026-11-11T00:00:00.000Z",
});

const CREATED = new Date("2026-11-10T10:00:00.000Z");
const UPDATED = new Date("2026-11-10T12:00:00.000Z");
const PAID = new Date("2026-11-10T11:00:00.000Z");
const PREPARED = new Date("2026-11-10T10:30:00.000Z");
const CONSUMED = new Date("2026-11-10T10:45:00.000Z");
const MOVEMENT_AT = new Date("2026-11-10T10:45:00.000Z");

function oid(suffix) {
  return new ObjectId(String(suffix).padStart(24, "0"));
}

export const ITEM_A = oid("a1");
export const ITEM_B = oid("b1");
export const ITEM_C = oid("c1");

function component(id, itemId, stockQuantity) {
  return Object.freeze({
    componentId: id,
    kind: "PRICED_COMPONENT",
    note: null,
    name: "L2 synthetic component",
    quantity: 1,
    unitPrice: 10,
    lineSum: 10,
    inventoryItemId: itemId,
    stockQuantity,
    stockUnit: "kg",
    costSnapshot: 1,
    totalCost: 1,
  });
}

function line(lineId, options = {}) {
  const { quantity = 1, cancelled = false, components = [] } = options;
  return Object.freeze({
    lineId,
    name: "L2 synthetic line",
    price: 10,
    quantity,
    type: "FOOD",
    isExternal: false,
    itemId: null,
    cancelled,
    cancelledAt: null,
    cancelledBy: null,
    cancelledStation: null,
    cancelReason: null,
    components: Object.freeze(components),
  });
}

function order(suffix, overrides = {}) {
  const id = oid(suffix);
  return Object.freeze({
    _id: id,
    orderNumber: `L2-${String(suffix).toUpperCase()}`,
    tableNumber: 1,
    waiterName: "L2 synthetic waiter",
    waiterId: null,
    waiterNumber: null,
    waiterInfo: null,
    kitchenStaffId: null,
    baristaStaffId: null,
    hotDrinkStaffId: null,
    items: Object.freeze([]),
    isExternal: false,
    status: "PENDING",
    totalAmount: 100,
    paymentMethod: "CASH",
    paymentAccountId: null,
    paymentAccountSnapshot: null,
    paymentSubmittedAt: null,
    paymentSubmittedBy: null,
    paymentVerifiedAt: null,
    paymentVerifiedBy: null,
    paymentRejectedAt: null,
    paymentRejectedBy: null,
    paymentRejectionReason: null,
    preparingAt: null,
    readyAt: null,
    servedAt: null,
    paidAt: null,
    completedAt: null,
    kitchenStatus: null,
    baristaStatus: null,
    hotDrinkStatus: null,
    kitchenPreparingAt: null,
    kitchenReadyAt: null,
    baristaPreparingAt: null,
    baristaReadyAt: null,
    hotDrinkPreparingAt: null,
    hotDrinkReadyAt: null,
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...overrides,
  });
}

function reservationItem(itemId, quantities) {
  const {
    requiredQuantity,
    reservedQuantity = 0,
    shortageQuantity = 0,
    consumedQuantity = 0,
  } = quantities;
  return Object.freeze({
    inventoryItemId: itemId,
    unit: "kg",
    requiredQuantity,
    reservedQuantity,
    shortageQuantity,
    availableAtDecision: 10,
    consumedQuantity,
  });
}

function reservation(suffix, orderDoc, status, items, overrides = {}) {
  return Object.freeze({
    _id: oid(suffix),
    orderId: orderDoc._id,
    orderNumber: orderDoc.orderNumber,
    status,
    items: Object.freeze(items),
    requirementFingerprint: `req:${suffix}`,
    shortageFingerprint: `short:${suffix}`,
    warnings: Object.freeze([]),
    approval: null,
    decisionAt: UPDATED,
    consumedAt: null,
    consumedBy: null,
    consumedTrigger: null,
    releasedAt: null,
    releaseReason: null,
    voidedAt: null,
    voidReason: null,
    voidedBy: null,
    voids: Object.freeze([]),
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...overrides,
  });
}

function movement(suffix, orderDoc, itemId, quantity, overrides = {}) {
  return Object.freeze({
    _id: oid(suffix),
    item: itemId,
    type: "OUT",
    quantity,
    reason: "SaleDeduction",
    createdBy: null,
    refOrderId: orderDoc._id,
    idempotencyKey: `sale:${orderDoc._id.toHexString()}:${itemId.toHexString()}`,
    supplier: null,
    unit: "kg",
    unitCost: 1,
    totalCost: 1,
    voidedAt: null,
    voidReason: null,
    voidedBy: null,
    notes: "",
    createdAt: MOVEMENT_AT,
    updatedAt: MOVEMENT_AT,
    ...overrides,
  });
}

function inventoryItem(id, name) {
  return Object.freeze({
    _id: id,
    name,
    unit: "kg",
    currentStock: 100,
    reservedStock: 0,
    createdAt: CREATED,
    updatedAt: UPDATED,
  });
}

export const INVENTORY_ITEMS = Object.freeze([
  inventoryItem(ITEM_A, "L2 synthetic item A"),
  inventoryItem(ITEM_B, "L2 synthetic item B"),
  inventoryItem(ITEM_C, "L2 synthetic item C"),
]);

function buildCase(rule, orderDoc, extras, expected, allowedExtra = []) {
  return Object.freeze({
    rule,
    order: orderDoc,
    reservation: extras.reservation ?? null,
    movements: Object.freeze(extras.movements ?? []),
    expected: Object.freeze(expected.map((entry) => Object.freeze(entry))),
    allowedExtra: Object.freeze(allowedExtra.map((entry) => Object.freeze(entry))),
  });
}

// D01 — PAID order with an inventory requirement and no reservation/deduction.
const d01Order = order("d01", {
  status: "PAID",
  paymentMethod: "CASH",
  paidAt: PAID,
  paymentSubmittedAt: PAID,
  paymentVerifiedAt: PAID,
  items: Object.freeze([
    line(oid("101"), { components: [component(oid("201"), ITEM_A, 2)] }),
  ]),
});
const D01 = buildCase(
  "D01",
  d01Order,
  {},
  [{ rule: "D01", code: "PAID_NO_RESERVATION_NO_DEDUCTION" }],
);

// D02 — active (unprepared) order with a sale deduction.
const d02Order = order("d02", {
  status: "PREPARING",
  paymentSubmittedAt: PAID,
  items: Object.freeze([
    line(oid("102"), { components: [component(oid("202"), ITEM_A, 2)] }),
  ]),
});
const D02 = buildCase(
  "D02",
  d02Order,
  { movements: [movement(oid("302"), d02Order, ITEM_A, 2)] },
  [{ rule: "D02", code: "DEDUCTION_WITHOUT_PREPARATION_OR_PAYMENT" }],
);

// D03 — duplicate sale movement identity and duplicate sale idempotency key.
const d03Order = order("d03", {
  status: "PAID",
  paidAt: PAID,
  paymentSubmittedAt: PAID,
  paymentVerifiedAt: PAID,
  items: Object.freeze([
    line(oid("103"), { components: [component(oid("203"), ITEM_A, 2)] }),
  ]),
});
const d03Reservation = reservation(
  "403",
  d03Order,
  "CONSUMED",
  [reservationItem(ITEM_A, { requiredQuantity: 2, consumedQuantity: 2 })],
  { consumedAt: CONSUMED, consumedTrigger: "PREPARING" },
);
const d03MovementA = movement(oid("303"), d03Order, ITEM_A, 1);
const d03MovementB = movement(oid("304"), d03Order, ITEM_A, 1);
const D03 = buildCase(
  "D03",
  d03Order,
  { reservation: d03Reservation, movements: [d03MovementA, d03MovementB] },
  [
    { rule: "D03", code: "DUPLICATE_MOVEMENT_IDENTITY" },
    { rule: "D03", code: "DUPLICATE_IDEMPOTENCY_KEY" },
  ],
  [{ rule: "D03", code: "INDEX_ABSENT_SUSPECTED" }],
);

// D04 — APPROVED reservation with no approval record.
const d04Order = order("d04", { status: "PENDING" });
const d04Reservation = reservation("404", d04Order, "APPROVED", [
  reservationItem(ITEM_A, { requiredQuantity: 2, reservedQuantity: 2 }),
]);
const D04 = buildCase(
  "D04",
  d04Order,
  { reservation: d04Reservation },
  [{ rule: "D04", code: "APPROVED_WITHOUT_APPROVAL" }],
);

// D05 — PAID order still holding a live reservation.
const d05Order = order("d05", {
  status: "PAID",
  paidAt: PAID,
  paymentSubmittedAt: PAID,
  paymentVerifiedAt: PAID,
});
const d05Reservation = reservation("405", d05Order, "RESERVED", [
  reservationItem(ITEM_A, { requiredQuantity: 2, reservedQuantity: 2 }),
]);
const D05 = buildCase(
  "D05",
  d05Order,
  { reservation: d05Reservation },
  [{ rule: "D05", code: "PAID_WITH_LIVE_HOLD" }],
  [{ rule: "D01", code: "PAID_WITH_LIVE_RESERVATION" }],
);

// D06 — CONSUMING reservation whose movements are complete and hold no stock.
const d06Order = order("d06", {
  status: "PREPARING",
  preparingAt: PREPARED,
  paymentSubmittedAt: PAID,
  items: Object.freeze([
    line(oid("106"), { components: [component(oid("206"), ITEM_A, 2)] }),
  ]),
});
const d06Reservation = reservation("406", d06Order, "CONSUMING", [
  reservationItem(ITEM_A, { requiredQuantity: 2 }),
]);
const D06 = buildCase(
  "D06",
  d06Order,
  {
    reservation: d06Reservation,
    movements: [movement(oid("306"), d06Order, ITEM_A, 2)],
  },
  [{ rule: "D06", code: "CONSUMING_MOVEMENTS_COMPLETE" }],
);

// D07 — CONSUMED reservation whose movement quantity does not match.
const d07Order = order("d07", {
  status: "PAID",
  paidAt: PAID,
  paymentSubmittedAt: PAID,
  paymentVerifiedAt: PAID,
  items: Object.freeze([
    line(oid("107"), { components: [component(oid("207"), ITEM_A, 2)] }),
  ]),
});
const d07Reservation = reservation(
  "407",
  d07Order,
  "CONSUMED",
  [reservationItem(ITEM_A, { requiredQuantity: 2, consumedQuantity: 1 })],
  { consumedAt: CONSUMED, consumedTrigger: "PREPARING" },
);
const D07 = buildCase(
  "D07",
  d07Order,
  {
    reservation: d07Reservation,
    movements: [movement(oid("307"), d07Order, ITEM_A, 2)],
  },
  [{ rule: "D07", code: "CONSUMED_MOVEMENT_MISMATCH" }],
);

// D08 — CANCELLED order whose consumed sale was not voided/reclassified.
const d08Line = line(oid("108"), {
  components: [component(oid("208"), ITEM_A, 1)],
});
const d08Order = order("d08", {
  status: "CANCELLED",
  paymentSubmittedAt: PAID,
  items: Object.freeze([d08Line]),
});
const d08Reservation = reservation(
  "408",
  d08Order,
  "CONSUMED",
  [reservationItem(ITEM_A, { requiredQuantity: 1, consumedQuantity: 1 })],
  {
    consumedAt: CONSUMED,
    consumedTrigger: "PREPARING",
    voids: Object.freeze([
      Object.freeze({
        at: UPDATED,
        by: null,
        reason: "synthetic line cancellation",
        phase: "AFTER_PREPARATION",
        source: "LINE",
        lineId: d08Line.lineId,
        station: "KITCHEN",
        items: Object.freeze([
          Object.freeze({ inventoryItemId: ITEM_A, unit: "kg", quantity: 1 }),
        ]),
      }),
    ]),
  },
);
const D08 = buildCase(
  "D08",
  d08Order,
  {
    reservation: d08Reservation,
    movements: [movement(oid("308"), d08Order, ITEM_A, 1)],
  },
  [
    { rule: "D08", code: "CANCELLED_NO_ORDER_VOID" },
    { rule: "D08", code: "CANCELLED_SALE_NOT_RECLASSIFIED" },
  ],
);

// D09 — PAID order missing paidAt and payment method.
const d09Order = order("d09", {
  status: "PAID",
  paymentMethod: null,
  paidAt: null,
  paymentSubmittedAt: PAID,
  items: Object.freeze([]),
});
const D09 = buildCase(
  "D09",
  d09Order,
  {},
  [
    { rule: "D09", code: "PAID_WITHOUT_PAID_AT" },
    { rule: "D09", code: "PAID_WITHOUT_METHOD" },
  ],
  [{ rule: "D01", code: "NO_INVENTORY_REQUIREMENT" }],
);

// D10 — negative order-line quantity (gating structural defect).
const d10Order = order("d10", {
  status: "PENDING",
  items: Object.freeze([line(oid("110"), { quantity: -1 })]),
});
const D10 = buildCase(
  "D10",
  d10Order,
  {},
  [{ rule: "D10", code: "NEGATIVE_QUANTITY" }],
);

export const FIXTURE_CASES = Object.freeze([D01, D02, D03, D04, D05, D06, D07, D08, D09, D10]);

export const EXPECTED_RULES = Object.freeze(FIXTURE_CASES.map((entry) => entry.rule));

export function fixtureDocuments() {
  const orders = FIXTURE_CASES.map((entry) => entry.order);
  const reservations = FIXTURE_CASES
    .map((entry) => entry.reservation)
    .filter((entry) => entry !== null);
  const movements = FIXTURE_CASES.flatMap((entry) => entry.movements);
  return Object.freeze({
    orders: Object.freeze(orders),
    reservations: Object.freeze(reservations),
    movements: Object.freeze(movements),
    inventory: INVENTORY_ITEMS,
  });
}

export function expectedCollectionCounts() {
  const documents = fixtureDocuments();
  return Object.freeze({
    orders: documents.orders.length,
    inventoryreservations: documents.reservations.length,
    stockmovements: documents.movements.length,
    inventoryitems: documents.inventory.length,
  });
}

/**
 * Build the bundle shape consumed by `projectEvidence()` for one fixture case.
 * Used by the DB-free coverage test; it performs no I/O.
 */
export function caseEvidenceInput(entry) {
  return Object.freeze({
    order: entry.order,
    reservation: entry.reservation,
    movements: entry.movements,
    inventory: INVENTORY_ITEMS,
  });
}
