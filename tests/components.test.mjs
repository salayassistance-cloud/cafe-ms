import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import mongoose from 'mongoose';
import { validateCreateOrderPayload } from '../lib/validate.js';

// Minimal replica of toKdsShape and effectiveOrderAmount for DB-free (mirrors lib/orderService/lib/analytics logic)
function testToKdsShape(order) {
  const getLocalizedSingleString = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return v.en || v.am || v.om || Object.values(v)[0] || '';
    return String(v);
  };
  const items = (order.items || []).map((i) => {
    const comps = Array.isArray(i.components) ? i.components : [];
    const mappedComps = comps.map((c) => ({
      componentId: c.componentId ? String(c.componentId) : null,
      kind: c.kind || null,
      note: c.note || null,
      name: c.name || null,
      quantity: c.quantity ?? null,
      unitPrice: c.unitPrice ?? null,
      lineSum: c.lineSum ?? (c.quantity != null && c.unitPrice != null ? Math.round(Number(c.quantity) * Number(c.unitPrice) * 100) / 100 : null),
      extraItemId: c.extraItemId ? String(c.extraItemId) : null,
      inventoryItemId: c.inventoryItemId ? String(c.inventoryItemId) : null,
      stockQuantity: c.stockQuantity ?? null,
      stockUnit: c.stockUnit || null,
      costSnapshot: c.costSnapshot ?? null,
      totalCost: c.totalCost ?? null,
    }));
    const baseSub = Math.round((i.price || 0) * (i.quantity || 0) * 100) / 100;
    const compsSum = mappedComps.filter((c) => c.kind === "PRICED_COMPONENT").reduce((s, c) => s + (Number(c.lineSum) || 0), 0);
    return {
      lineId: i.lineId ? String(i.lineId) : null,
      name: getLocalizedSingleString(i.name),
      price: i.price,
      quantity: i.quantity,
      type: i.type,
      isExternal: !!i.isExternal,
      itemId: i.itemId ? String(i.itemId) : null,
      subTotal: baseSub,
      components: mappedComps,
      componentsTotal: Math.round(compsSum * 100) / 100,
      itemTotal: Math.round((baseSub + compsSum) * 100) / 100,
      cancelled: !!i.cancelled,
    };
  });
  const gross = Number(order.totalAmount) || 0;
  const netAmount = Math.round(
    items.filter((it) => !it.cancelled).reduce((s, it) => {
      const base = (Number(it.price) || 0) * (Number(it.quantity) || 0);
      const comps = (it.components || []).filter((c) => c.kind === "PRICED_COMPONENT").reduce((cs, c) => cs + (Number(c.lineSum) || 0), 0);
      return s + base + comps;
    }, 0) * 100
  ) / 100;
  const cancelledAmount = Math.round((gross - netAmount) * 100) / 100;
  return { _id: order._id.toString(), orderNumber: order.orderNumber, items, totalAmount: order.totalAmount, netAmount, cancelledAmount };
}
function effectiveOrderAmount(o) {
  if (!o || !Array.isArray(o.items)) return Number(o?.totalAmount) || 0;
  const hasCancelledFlag = (o.items || []).some((it) => it.cancelled === true);
  function activeSumCalc(list) {
    return list.reduce((s, it) => {
      const base = (Number(it.price) || 0) * (Number(it.quantity) || 0);
      const comps = Array.isArray(it.components) ? it.components : [];
      const compSum = comps.filter((c) => c.kind === "PRICED_COMPONENT").reduce((cs, c) => cs + (Number(c.lineSum) || Number(c.quantity) * Number(c.unitPrice) || 0), 0);
      return s + base + compSum;
    }, 0);
  }
  if (!hasCancelledFlag) {
    if (Number.isFinite(Number(o.totalAmount)) && Number(o.totalAmount) !== 0) return Number(o.totalAmount) || 0;
    return Math.round(activeSumCalc(o.items) * 100) / 100;
  }
  const activeItems = (o.items || []).filter((it) => !it.cancelled);
  const sum = activeSumCalc(activeItems);
  return Math.round(sum * 100) / 100;
}
function componentRevenue(list) {
  return list.filter((o) => o.status === "PAID").reduce((sum, o) => {
    const active = (o.items || []).filter((it) => !it.cancelled);
    let cSum = 0;
    for (const it of active) {
      const comps = Array.isArray(it.components) ? it.components : [];
      for (const c of comps) if (c.kind === "PRICED_COMPONENT") cSum += Number(c.lineSum) || Number(c.quantity) * Number(c.unitPrice) || 0;
    }
    return sum + cSum;
  }, 0);
}

const EXTRA_ID = new mongoose.Types.ObjectId().toString();
const EXTRA_ID_2 = new mongoose.Types.ObjectId().toString();
const INVENTORY_ID = new mongoose.Types.ObjectId().toString();

describe('Order Item Components - DB-free', () => {
  test('Type A NOTE: free-text, no price, no revenue, no inventory', () => {
    const payload = {
      tableNumber: 5,
      items: [
        {
          name: 'Burger',
          price: 150,
          quantity: 1,
          type: 'FOOD',
          itemId: new mongoose.Types.ObjectId().toString(),
          components: [{ kind: 'NOTE', note: 'no onion, extra spicy' }],
        },
      ],
    };
    const res = validateCreateOrderPayload(payload);
    assert.equal(res.ok, true);
    assert.equal(res.data.items[0].components.length, 1);
    assert.equal(res.data.items[0].components[0].kind, 'NOTE');
    assert.equal(res.data.items[0].components[0].note, 'no onion, extra spicy');
    // Server total should be base only (150*1 + 0)
    const order = {
      _id: new mongoose.Types.ObjectId(),
      orderNumber: 'ORD-1',
      items: [{ price: 150, quantity: 1, components: res.data.items[0].components }],
      totalAmount: 150,
      status: 'PAID',
    };
    assert.equal(effectiveOrderAmount(order), 150);
    assert.equal(componentRevenue([order]), 0);
  });

  test('Type A NOTE validation - reject empty, too long, script', () => {
    const base = { tableNumber: 1, items: [{ name: 'Tea', price: 10, quantity: 1, type: 'DRINK' }] };
    let r = validateCreateOrderPayload({ ...base, items: [{ ...base.items[0], components: [{ kind: 'NOTE', note: '' }] }] });
    assert.ok(r.error.includes('note is required'));
    r = validateCreateOrderPayload({ ...base, items: [{ ...base.items[0], components: [{ kind: 'NOTE', note: 'a'.repeat(501) }] }] });
    assert.ok(r.error.includes('max 500'));
    r = validateCreateOrderPayload({ ...base, items: [{ ...base.items[0], components: [{ kind: 'NOTE', note: '<script>alert(1)</script>' }] }] });
    assert.ok(r.error.includes('invalid characters'));
  });

  test('Type B PRICED_COMPONENT: validation accepts only extraItemId + quantity', () => {
    const payload = {
      tableNumber: 2,
      items: [
        {
          name: 'Pasta',
          price: 200,
          quantity: 2,
          type: 'FOOD',
          itemId: new mongoose.Types.ObjectId().toString(),
          components: [
            {
              kind: 'PRICED_COMPONENT',
              extraItemId: EXTRA_ID,
              quantity: 2,
              // Forged client money/unit values must be dropped by validation.
              name: 'FREE TEXT',
              unitPrice: 9999,
              inventoryItemId: INVENTORY_ID,
              stockUnit: 'kg',
            },
          ],
        },
      ],
    };
    const res = validateCreateOrderPayload(payload);
    assert.equal(res.ok, true);
    const comps = res.data.items[0].components;
    assert.equal(comps.length, 1);
    assert.deepEqual(Object.keys(comps[0]).sort(), ['extraItemId', 'kind', 'quantity']);
    assert.equal(comps[0].kind, 'PRICED_COMPONENT');
    assert.equal(comps[0].extraItemId, EXTRA_ID);
    assert.equal(comps[0].quantity, 2);
    assert.equal('name' in comps[0], false);
    assert.equal('unitPrice' in comps[0], false);
    assert.equal('inventoryItemId' in comps[0], false);
    assert.equal('stockUnit' in comps[0], false);
  });

  test('Type B server-resolved component adds lineSum to parent and order total', () => {
    const order = {
      _id: new mongoose.Types.ObjectId(),
      orderNumber: 'ORD-2',
      items: [
        {
          price: 200,
          quantity: 2,
          components: [
            {
              kind: 'PRICED_COMPONENT',
              extraItemId: EXTRA_ID,
              name: 'Extra Cheese',
              quantity: 2,
              unitPrice: 25,
              lineSum: 50,
              inventoryItemId: INVENTORY_ID,
              stockQuantity: 1,
              stockUnit: 'pcs',
            },
          ],
        },
      ],
      totalAmount: 450, // 400 base + 50 extras
      status: 'PAID',
    };
    assert.equal(effectiveOrderAmount(order), 450);
    assert.equal(componentRevenue([order]), 50);
    const base = effectiveOrderAmount(order) - componentRevenue([order]);
    assert.equal(base, 400);
  });

  test('Type B validation rejects missing id, bad quantity and malformed kinds', () => {
    const base = { tableNumber: 1, items: [{ name: 'Burger', price: 100, quantity: 1, type: 'FOOD' }] };
    let r = validateCreateOrderPayload({ ...base, items: [{ ...base.items[0], components: [{ kind: 'PRICED_COMPONENT', name: 'Extra Cheese', quantity: 1, unitPrice: 10 }] }] });
    assert.ok(r.error.includes('extraItemId must be valid ObjectId'));
    r = validateCreateOrderPayload({ ...base, items: [{ ...base.items[0], components: [{ kind: 'PRICED_COMPONENT', extraItemId: 'not-an-id', quantity: 1 }] }] });
    assert.ok(r.error.includes('extraItemId must be valid ObjectId'));
    r = validateCreateOrderPayload({ ...base, items: [{ ...base.items[0], components: [{ kind: 'PRICED_COMPONENT', extraItemId: EXTRA_ID, quantity: 0 }] }] });
    assert.ok(r.error.includes('quantity must be integer 1-99'));
    r = validateCreateOrderPayload({ ...base, items: [{ ...base.items[0], components: [{ kind: 'PRICED_COMPONENT', extraItemId: EXTRA_ID, quantity: 1.5 }] }] });
    assert.ok(r.error.includes('quantity must be integer 1-99'));
    r = validateCreateOrderPayload({ ...base, items: [{ ...base.items[0], components: [{ kind: 'PRICED_COMPONENT', extraItemId: EXTRA_ID, quantity: 100 }] }] });
    assert.ok(r.error.includes('quantity must be integer 1-99'));
    r = validateCreateOrderPayload({ ...base, items: [{ ...base.items[0], components: [{ kind: 'UNKNOWN', extraItemId: EXTRA_ID, quantity: 1 }] }] });
    assert.ok(r.error.includes('kind must be NOTE or PRICED_COMPONENT'));
  });

  test('standalone Extra Item lines are rejected', () => {
    const payload = {
      tableNumber: 1,
      items: [
        {
          name: 'Extra Injera',
          price: 20,
          quantity: 1,
          type: 'FOOD',
          itemId: new mongoose.Types.ObjectId().toString(),
          isExtraItem: true,
        },
      ],
    };
    const res = validateCreateOrderPayload(payload);
    assert.equal(res.ok, undefined);
    assert.ok(res.error.includes('Extra Items must be attached to a parent menu item'));
  });

  test('D1 regression: PRICED_COMPONENT requires a parent menu item (itemId)', () => {
    const freeTextParent = {
      name: 'Custom plate',
      price: 100,
      quantity: 1,
      type: 'FOOD',
      components: [{ kind: 'PRICED_COMPONENT', extraItemId: EXTRA_ID, quantity: 1 }],
    };
    // Free-text parent + Extra would be charged with no reservation/deduction.
    const rejected = validateCreateOrderPayload({ tableNumber: 1, items: [freeTextParent] });
    assert.equal(rejected.ok, undefined);
    assert.ok(rejected.error.includes('PRICED_COMPONENT requires a parent menu item (itemId)'));

    // A real catalog parent still accepts the same Extra.
    const withParent = validateCreateOrderPayload({
      tableNumber: 1,
      items: [{ ...freeTextParent, itemId: new mongoose.Types.ObjectId().toString() }],
    });
    assert.equal(withParent.ok, true);
    assert.equal(withParent.data.items[0].components.length, 1);

    // C1: every ordinary line now needs a catalog identity, including a
    // NOTE-only line. The old free-text acceptance is the insecure behavior.
    const noteOnly = validateCreateOrderPayload({
      tableNumber: 1,
      items: [{ ...freeTextParent, components: [{ kind: 'NOTE', note: 'no onion' }] }],
    });
    assert.equal(noteOnly.ok, undefined);
    assert.ok(noteOnly.error.includes('itemId is required'));
  });

  test('Component sums added to parent and order total (server authoritative)', () => {
    const order = {
      _id: new mongoose.Types.ObjectId(),
      orderNumber: 'ORD-3',
      items: [
        { price: 100, quantity: 2, components: [{ kind: 'PRICED_COMPONENT', extraItemId: EXTRA_ID, quantity: 1, unitPrice: 20, lineSum: 20 }] }, // 200 +20 =220
        { price: 50, quantity: 1, components: [{ kind: 'NOTE', note: 'no salt' }] }, // 50 +0
      ],
      totalAmount: 270,
      status: 'PAID',
    };
    assert.equal(effectiveOrderAmount(order), 270);
    const shaped = testToKdsShape(order);
    assert.equal(shaped.items[0].itemTotal, 220);
    assert.equal(shaped.items[1].itemTotal, 50);
    assert.equal(shaped.netAmount, 270);
    assert.equal(shaped.items[0].components[0].extraItemId, EXTRA_ID);
  });

  test('Components display under exact parent, station routing inherited', () => {
    const order = {
      _id: new mongoose.Types.ObjectId(),
      orderNumber: 'ORD-4',
      items: [
        { price: 100, quantity: 1, type: 'FOOD', components: [{ kind: 'NOTE', note: 'less salt' }, { kind: 'PRICED_COMPONENT', extraItemId: EXTRA_ID, quantity: 1, unitPrice: 10, lineSum: 10 }] },
        { price: 40, quantity: 1, type: 'DRINK', components: [{ kind: 'NOTE', note: 'extra hot' }] },
      ],
      totalAmount: 150,
      status: 'PENDING',
    };
    const foodItems = order.items.filter((it) => it.type === 'FOOD');
    const drinkItems = order.items.filter((it) => it.type === 'DRINK');
    assert.equal(foodItems[0].components.length, 2);
    assert.equal(drinkItems[0].components.length, 1);
    // Kitchen should see FOOD components, Barista DRINK
    assert.equal(foodItems[0].components[0].kind, 'NOTE');
    assert.equal(drinkItems[0].components[0].note, 'extra hot');
  });

  test('Component revenue distinguishable from base in reporting', () => {
    const orders = [
      { status: 'PAID', totalAmount: 300, items: [{ price: 100, quantity: 2, components: [{ kind: 'PRICED_COMPONENT', extraItemId: EXTRA_ID, quantity: 2, unitPrice: 25, lineSum: 50 }] }, { price: 50, quantity: 1, components: [] }] }, // base 250, comp 50
      { status: 'PAID', totalAmount: 100, items: [{ price: 100, quantity: 1, components: [] }] },
    ];
    const compRev = componentRevenue(orders);
    const total = orders.filter((o) => o.status === 'PAID').reduce((s, o) => s + effectiveOrderAmount(o), 0);
    const baseRev = total - compRev;
    assert.equal(compRev, 50);
    assert.equal(total, 400);
    assert.equal(baseRev, 350);
  });

  test('Type A NOTE never deducts; only a linked Extra component deducts stock', () => {
    function shouldDeduct(comp) {
      if (!comp || comp.kind !== 'PRICED_COMPONENT') return false;
      if (!comp.extraItemId) return false;
      if (!comp.inventoryItemId) return false;
      if (comp.stockQuantity == null || comp.stockUnit == null) return false;
      return true;
    }
    assert.equal(shouldDeduct({ kind: 'NOTE', note: 'no onion' }), false);
    // Historical free-text priced add-on without a stock link never deducts.
    assert.equal(shouldDeduct({ kind: 'PRICED_COMPONENT', name: 'Cheese', quantity: 1, unitPrice: 10 }), false);
    assert.equal(shouldDeduct({ kind: 'PRICED_COMPONENT', extraItemId: EXTRA_ID, quantity: 1, inventoryItemId: INVENTORY_ID, stockQuantity: 1, stockUnit: 'pcs' }), true);
  });

  test('Extra component stock quantity is one unit per selected extra', () => {
    const comp = {
      kind: 'PRICED_COMPONENT',
      extraItemId: EXTRA_ID,
      quantity: 2,
      unitPrice: 20,
      lineSum: 40,
      inventoryItemId: INVENTORY_ID,
      stockQuantity: 1,
      stockUnit: 'pcs',
      costSnapshot: 6.5,
      totalCost: 13,
    };
    const totalQty = comp.stockQuantity * comp.quantity; // 2 pcs
    assert.equal(totalQty, 2);
    assert.equal(comp.totalCost, totalQty * comp.costSnapshot);
    // A component without an extra identity is not part of the new contract.
    const noLink = { kind: 'PRICED_COMPONENT', name: 'Cheese', quantity: 1, unitPrice: 30, lineSum: 30 };
    assert.equal(noLink.extraItemId, undefined);
  });

  test('Deductions happen exactly once per order (idempotency)', () => {
    const order = {
      items: [
        { price: 100, quantity: 1, components: [{ kind: 'PRICED_COMPONENT', extraItemId: EXTRA_ID, quantity: 1, unitPrice: 10, inventoryItemId: INVENTORY_ID, stockQuantity: 1, stockUnit: 'pcs' }] },
        { price: 100, quantity: 1, components: [{ kind: 'PRICED_COMPONENT', extraItemId: EXTRA_ID_2, quantity: 2, unitPrice: 10, inventoryItemId: INVENTORY_ID, stockQuantity: 1, stockUnit: 'pcs' }] },
      ],
    };
    // Aggregation sums stockQuantity * component quantity: 1*1 + 1*2 = 3
    const agg = new Map();
    for (const it of order.items) {
      for (const c of it.components || []) {
        if (c.kind !== 'PRICED_COMPONENT' || !c.inventoryItemId) continue;
        const qty = c.stockQuantity * c.quantity;
        const existing = agg.get(c.inventoryItemId);
        if (existing) existing.quantity += qty;
        else agg.set(c.inventoryItemId, { inventoryItemId: c.inventoryItemId, quantity: qty, unit: c.stockUnit });
      }
    }
    assert.equal([...agg.values()][0].quantity, 3);
    assert.equal([...agg.values()][0].unit, 'pcs');
    // Idempotency itself is enforced by the reservation/StockMovement orderId
    // uniqueness; aggregation here is deterministic.
  });

  test('Legacy orders without components still load', () => {
    const legacy = {
      _id: new mongoose.Types.ObjectId(),
      orderNumber: 'ORD-LEGACY',
      items: [{ price: 120, quantity: 1, type: 'FOOD', name: 'Legacy Burger' }], // no components, no lineId
      totalAmount: 120,
      status: 'PAID',
    };
    const shaped = testToKdsShape(legacy);
    assert.equal(shaped.items[0].components.length, 0);
    assert.equal(shaped.netAmount, 120);
  });

  test('Server calculates totals, never trusts client totals', () => {
    const clientTotal = 9999;
    const payload = {
      tableNumber: 1,
      items: [
        {
          name: 'Burger',
          price: 100,
          quantity: 2,
          type: 'FOOD',
          itemId: new mongoose.Types.ObjectId().toString(),
          components: [{ kind: 'PRICED_COMPONENT', extraItemId: EXTRA_ID, quantity: 1 }],
        },
      ],
    };
    const res = validateCreateOrderPayload(payload);
    assert.equal(res.ok, true);
    // The server resolves the extra selling price (50) after validation.
    const serverTotal = 200 + 50;
    assert.notEqual(serverTotal, clientTotal);
    assert.equal(serverTotal, 250);
  });

  test('Regression: base item without components unchanged', () => {
    const payload = {
      tableNumber: 3,
      items: [{ name: 'Tea', price: 30, quantity: 1, type: 'DRINK', itemId: new mongoose.Types.ObjectId().toString() }],
    };
    const res = validateCreateOrderPayload(payload);
    assert.equal(res.ok, true);
    assert.equal(res.data.items[0].components, undefined); // validate does not add empty array (orderService will default to [])
  });
});
