// Read-only report breakdowns. Callers provide the canonical order and line
// amount functions so this helper never becomes an alternate revenue engine.

const TRANSFER_METHODS = new Set(['TRANSFER', 'TELEBIRR']);
const UNKNOWN_PAYMENT_METHOD = 'UNKNOWN';

// Order items persist the canonical FOOD/DRINK type snapshot. Legacy lines may
// only carry categoryType; no names, prices, or order ids are ever used to
// infer a type. A line that cannot be attributed explicitly stays unattributed.
function resolveItemType(item) {
  const raw = item?.type ?? item?.categoryType;
  if (typeof raw !== 'string') return null;
  const type = raw.trim().toUpperCase();
  return type === 'FOOD' || type === 'DRINK' ? type : null;
}

function resolvePaymentEntry(order) {
  const rawMethod = typeof order?.paymentMethod === 'string'
    ? order.paymentMethod.trim().toUpperCase()
    : '';
  const bankName = typeof order?.paymentAccountSnapshot?.bankName === 'string'
    ? order.paymentAccountSnapshot.bankName.trim()
    : '';

  if (rawMethod === 'CASH') {
    return { key: 'CASH', method: 'CASH', bankName: null };
  }
  if (TRANSFER_METHODS.has(rawMethod)) {
    // The bank snapshot is the canonical persisted PaymentInfo identity at
    // payment time. Distinct banks/accounts stay distinct; a missing snapshot
    // remains a generic transfer rather than being guessed.
    const bankKey = bankName ? bankName.toUpperCase() : 'UNSPECIFIED';
    return {
      key: `TRANSFER:${bankKey}`,
      method: 'TRANSFER',
      bankName: bankName || null,
    };
  }

  // NONE, missing, or an invalid persisted value. Never fold this amount into
  // Cash or a real transfer method.
  return { key: UNKNOWN_PAYMENT_METHOD, method: UNKNOWN_PAYMENT_METHOD, bankName: null };
}

export function buildRevenueBreakdowns(orders, { effectiveOrderAmount, activeItemAmount }) {
  let foodRevenue = 0;
  let drinkRevenue = 0;
  let totalPaidRevenue = 0;
  const paymentMethods = new Map();
  const seenOrderIds = new Set();

  for (const order of Array.isArray(orders) ? orders : []) {
    if (order?.status !== 'PAID') continue;
    const orderId = order?._id ? String(order._id) : null;
    // A Mongo query returns each _id once. This guard also prevents an
    // accidental duplicate document from being counted as a second payment.
    if (orderId && seenOrderIds.has(orderId)) continue;
    if (orderId) seenOrderIds.add(orderId);

    // This is the same canonical amount used by the report's paid total. It is
    // applied once per paid order, never once per payment-method field.
    const amount = Number(effectiveOrderAmount(order)) || 0;
    totalPaidRevenue += amount;

    for (const item of Array.isArray(order.items) ? order.items : []) {
      if (item?.cancelled === true) continue;
      const lineAmount = Number(activeItemAmount(item)) || 0;
      const type = resolveItemType(item);
      if (type === 'FOOD') foodRevenue += lineAmount;
      else if (type === 'DRINK') drinkRevenue += lineAmount;
    }

    const entry = resolvePaymentEntry(order);
    const existing = paymentMethods.get(entry.key);
    if (existing) {
      existing.amount += amount;
      existing.count += 1;
    } else {
      paymentMethods.set(entry.key, { ...entry, amount, count: 1 });
    }
  }

  const food = Math.round(foodRevenue);
  const drink = Math.round(drinkRevenue);
  const paid = Math.round(totalPaidRevenue);
  return {
    foodRevenue: food,
    drinkRevenue: drink,
    // Any legacy/invalid item type or authoritative-total mismatch remains
    // visibly unattributed rather than being guessed as food or drink.
    unattributedRevenue: paid - food - drink,
    paymentBreakdown: Array.from(paymentMethods.values())
      .map((entry) => ({ ...entry, amount: Math.round(entry.amount) }))
      .sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key)),
  };
}
