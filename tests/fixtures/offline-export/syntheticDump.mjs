// tests/fixtures/offline-export/syntheticDump.mjs — deterministic synthetic
// dump input for the offline sanitizer/validator tests (Phase 2, Step 8).
//
// SYNTHETIC ONLY: these are fabricated documents shaped like canonical
// Extended JSON v2 (what `bsondump` emits from a mongodump directory).
// No real database data, no connections, no secrets — the "key" below is a
// public test fixture, not a credential.

export const SYNTHETIC_KEY_HEX = "11".repeat(32);

export const ID = {
  item1: "64b1f0c0a1b2c3d4e5f60711",
  item2: "64b1f0c0a1b2c3d4e5f60712",
  item3: "64b1f0c0a1b2c3d4e5f60713",
  item4: "64b1f0c0a1b2c3d4e5f60714",
  item5: "64b1f0c0a1b2c3d4e5f60715",
  item6: "64b1f0c0a1b2c3d4e5f60716",
  itemOrphan: "64b1f0c0a1b2c3d4e5f69999",
  recipe1: "64b1f0c0a1b2c3d4e5f60721",
  recipe2: "64b1f0c0a1b2c3d4e5f60722",
  reservation1: "64b1f0c0a1b2c3d4e5f60731",
  reservation2: "64b1f0c0a1b2c3d4e5f60732",
  order1: "64b1f0c0a1b2c3d4e5f60741",
  order2: "64b1f0c0a1b2c3d4e5f60742",
  orderOrphan: "64b1f0c0a1b2c3d4e5f68888",
  line1: "64b1f0c0a1b2c3d4e5f60751",
  component1: "64b1f0c0a1b2c3d4e5f60761",
  component2: "64b1f0c0a1b2c3d4e5f60762",
};

export const oid = (hex) => ({ $oid: hex });
export const dbl = (s) => ({ $numberDouble: s });
export const int = (n) => ({ $numberInt: String(n) });
export const lng = (s) => ({ $numberLong: s });
export const dec = (s) => ({ $numberDecimal: s });
export const dateMs = (ms) => ({ $date: { $numberLong: String(ms) } });
export const dateIso = (s) => ({ $date: s });
export const binary = () => ({ $binary: { base64: "AAEC", subType: "03" } });

export function buildSyntheticDump() {
  return {
    inventoryitems: [
      {
        _id: oid(ID.item1),
        unit: "kg",
        currentStock: dbl("12.5"),
        reservedStock: dbl("2.25"),
      },
      {
        _id: oid(ID.item2),
        unit: " KG ", // padded + case variant, never normalized
        currentStock: int(5),
        reservedStock: dbl("0"),
      },
      {
        _id: oid(ID.item3),
        unit: "", // empty-string state
        currentStock: dbl("-0"), // negative zero double
      },
      {
        _id: oid(ID.item4),
        unit: null, // null state
        currentStock: dbl("NaN"), // special double
        reservedStock: dec("10.5"), // Decimal128 drift
      },
      {
        _id: oid(ID.item5), // unit entirely missing
        currentStock: int(3),
        reservedStock: dbl("Infinity"),
      },
      {
        _id: oid(ID.item6),
        unit: "   ", // whitespace-only state (never trimmed)
        currentStock: int(1),
      },
    ],
    recipes: [
      {
        _id: oid(ID.recipe1),
        ingredients: [
          { inventoryItemId: oid(ID.item1), quantity: dbl("0.5"), unit: "kg" },
          { inventoryItemId: oid(ID.item2), quantity: lng("250"), unit: "ml" },
        ],
        isActive: true,
      },
      {
        _id: oid(ID.recipe2),
        menuItemId: oid(ID.item1), // excluded by the matrix (§1.2)
        ingredients: [
          // String-id drift (L3): pseudonymized via the |str| message.
          { inventoryItemId: "legacy-item-id", quantity: dbl("1"), unit: "TSP" },
        ],
        isActive: false,
      },
    ],
    stockmovements: [
      {
        item: oid(ID.item1),
        unit: "kg",
        quantity: dbl("10"),
        type: "IN",
        reason: "Purchase",
      },
      {
        item: oid(ID.itemOrphan), // orphan: not an exported inventoryitem
        unit: null,
        quantity: dec("3.33"),
        type: "OUT",
        reason: "SaleDeduction",
      },
      {
        item: oid(ID.item3),
        quantity: int(2), // unit missing (legacy)
        type: "ADJUSTMENT",
        reason: "Correction",
      },
    ],
    inventoryaudits: [
      {
        item: oid(ID.item1),
        unit: "kg",
        action: "ITEM_UPDATED",
        quantityDelta: dbl("-1.5"),
        beforeStock: dbl("14"),
        afterStock: dbl("12.5"),
        beforeSnapshot: {
          unit: "kg",
          currentStock: dbl("14"),
          secretNote: "free text", // unlisted key: excluded, counted
          cost: dbl("5"), // unlisted key: excluded, counted
        },
        afterSnapshot: {
          unit: null,
          currentStock: dbl("12.5"),
          stockUnit: " kg ",
          nested: { unit: "g" }, // allow-list key at depth
        },
      },
      {
        item: oid(ID.item4),
        action: "STOCK_ADDED",
        beforeStock: int(0),
        afterStock: lng("5"),
        beforeSnapshot: {
          // Drift: a date at an allow-listed numeric key — exported typed.
          currentStock: dateIso("2026-01-02T03:04:05.678Z"),
        },
        afterSnapshot: {
          // Drift: unknown BSON type at an allow-listed numeric key.
          currentStock: binary(),
          oddKey: oid(ID.item1), // unlisted key: excluded, counted
        },
      },
    ],
    inventoryreservations: [
      {
        _id: oid(ID.reservation1),
        orderId: oid(ID.order1),
        status: "APPROVED",
        items: [
          {
            inventoryItemId: oid(ID.item1),
            unit: "kg",
            requiredQuantity: dbl("0.5"),
            reservedQuantity: dbl("0.5"),
            shortageQuantity: dbl("0"),
            availableAtDecision: dbl("12.5"),
            consumedQuantity: dbl("0"),
          },
        ],
        requirementFingerprint: "f".repeat(64),
        shortageFingerprint: "e".repeat(64),
        approval: {
          requirementFingerprint: "f".repeat(64),
          shortageFingerprint: "e".repeat(64),
          shortages: [
            {
              inventoryItemId: oid(ID.item2),
              unit: " KG ",
              requiredQuantity: dbl("2"),
              availableQuantity: dbl("1"),
              shortageQuantity: dbl("1"),
            },
          ],
        },
        consumedTrigger: "PREPARING",
        voids: [],
      },
      {
        _id: oid(ID.reservation2),
        orderId: oid(ID.orderOrphan), // orphan order reference
        status: "CONSUMED",
        items: [
          {
            inventoryItemId: oid(ID.item4),
            unit: "",
            requiredQuantity: int(1),
            reservedQuantity: lng("1"),
            shortageQuantity: dbl("0"),
            availableAtDecision: dbl("0"),
            consumedQuantity: dbl("1"),
          },
        ],
        requirementFingerprint: "d".repeat(64),
        consumedTrigger: "PAYMENT",
        voids: [
          {
            phase: "AFTER_PREPARATION",
            source: "ORDER",
            station: "KITCHEN",
            lineId: oid(ID.line1), // shared orderline namespace with orders
            items: [
              { inventoryItemId: oid(ID.item4), unit: "", quantity: dbl("1") },
            ],
          },
          {
            phase: "BEFORE_PREPARATION",
            lineId: null, // legacy whole-order void: null stays null
            items: [],
          },
        ],
      },
    ],
    orders: [
      {
        _id: oid(ID.order1),
        items: [
          {
            lineId: oid(ID.line1),
            components: [
              {
                componentId: oid(ID.component1),
                kind: "PRICED_COMPONENT",
                inventoryItemId: oid(ID.item1),
                stockQuantity: dbl("0.5"),
                stockUnit: "kg",
              },
              {
                componentId: oid(ID.component2),
                kind: "DECOR", // filtered out (§1.6): not a priced component
                inventoryItemId: oid(ID.item2),
                stockQuantity: dbl("1"),
                stockUnit: "pcs",
              },
            ],
          },
        ],
        orderNumber: "ORD-100", // excluded
        waiterName: "WAITER", // excluded
        price: dbl("10"), // excluded
      },
      {
        _id: oid(ID.order2),
        items: [{ components: [] }], // lineId missing entirely
        note: "free text", // excluded
      },
    ],
  };
}
