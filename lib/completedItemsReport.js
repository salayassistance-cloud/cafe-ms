import { displayName } from './displayName.js';

// This cap bounds the manager analytics payload independently of the aggregate
// report. It is deliberately a line limit: a single order may contain several
// completed menu items.
export const COMPLETED_ITEMS_DETAIL_LIMIT = 200;

const FULFILLED_STATUSES = new Set(['READY', 'SERVED', 'PAID']);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function eventForOrder(order) {
  if (order.status === 'PAID') {
    if (order.paidAt) return { at: iso(order.paidAt), kind: 'PAID_AT' };
    if (order.paymentVerifiedAt) return { at: iso(order.paymentVerifiedAt), kind: 'PAYMENT_VERIFIED_AT' };
    if (order.completedAt) return { at: iso(order.completedAt), kind: 'COMPLETED_AT' };
    return { at: null, kind: null };
  }
  if (order.status === 'SERVED') return { at: iso(order.servedAt), kind: order.servedAt ? 'SERVED_AT' : null };
  if (order.status === 'READY') return { at: iso(order.readyAt), kind: order.readyAt ? 'READY_AT' : null };
  return { at: null, kind: null };
}

function projectComponent(component) {
  const quantity = finiteNumber(component?.quantity);
  const unitPrice = finiteNumber(component?.unitPrice);
  const storedLineSum = finiteNumber(component?.lineSum);
  const lineSum = storedLineSum ?? (
    quantity != null && unitPrice != null
      ? Math.round(quantity * unitPrice * 100) / 100
      : null
  );

  return {
    componentId: component?.componentId ? String(component.componentId) : null,
    kind: component?.kind || null,
    name: component?.name ? displayName(component.name) : null,
    note: component?.note || null,
    quantity,
    unitPrice,
    // A priced component's stored lineSum is already part of the canonical
    // order total. This field is displayed only as the component's own fact.
    lineSum,
  };
}

// Pure projection of the existing Order snapshot. It deliberately does not
// calculate a report total or mutate the canonical report KPIs.
export function buildCompletedItemsDetail(orders, { limit = COMPLETED_ITEMS_DETAIL_LIMIT } = {}) {
  const rows = [];
  let truncated = false;

  for (const order of Array.isArray(orders) ? orders : []) {
    if (!FULFILLED_STATUSES.has(order?.status)) continue;
    const event = eventForOrder(order);
    const orderId = order?._id ? String(order._id) : null;

    for (let index = 0; index < (Array.isArray(order.items) ? order.items.length : 0); index += 1) {
      const item = order.items[index];
      if (!item || item.cancelled === true) continue;
      if (rows.length >= limit) {
        truncated = true;
        return { rows, truncated };
      }

      const quantity = finiteNumber(item.quantity);
      const unitPrice = finiteNumber(item.price);
      rows.push({
        // rowKey is a response-only fallback for legacy lines without lineId;
        // it is never persisted or represented as an item identifier.
        rowKey: `${orderId || 'unknown-order'}:${item.lineId ? String(item.lineId) : index}`,
        orderId,
        orderNumber: order.orderNumber || null,
        waiterName: typeof order.waiterName === 'string' && order.waiterName.trim()
          ? order.waiterName.trim()
          : null,
        paymentMethod: typeof order.paymentMethod === 'string' && order.paymentMethod.trim()
          ? order.paymentMethod.trim().toUpperCase()
          : null,
        lineId: item.lineId ? String(item.lineId) : null,
        name: displayName(item.name),
        type: item.type || item.categoryType || null,
        quantity,
        unitPrice,
        // Base menu-line subtotal only. Priced components stay separate so
        // their already-included charge is never added a second time here.
        itemSubtotal: quantity != null && unitPrice != null
          ? Math.round(quantity * unitPrice * 100) / 100
          : null,
        components: (Array.isArray(item.components) ? item.components : []).map(projectComponent),
        tableNumber: finiteNumber(order.tableNumber),
        fulfillmentStatus: order.status,
        eventAt: event.at,
        eventKind: event.kind,
      });
    }
  }

  return { rows, truncated };
}
