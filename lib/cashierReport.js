import { activeItemAmount } from './analytics.js';
import { displayName } from './displayName.js';
import { resolveReportRange } from './reportService.js';
import { resolveItemType } from './reportRevenueBreakdown.js';
import { validateDateString } from './validate.js';

const FULFILLED_STATUSES = new Set(['READY', 'SERVED', 'PAID']);
const DAY_MS = 24 * 3600 * 1000;

export const CASHIER_MAX_REPORT_DAYS = 31;
export const CASHIER_REPORT_INTERVALS = Object.freeze([
  'today',
  'yesterday',
  'thisWeek',
  'thisMonth',
  'last7',
]);

const INTERVAL_LOOKUP = new Map(
  CASHIER_REPORT_INTERVALS.map((key) => [key.toLowerCase(), key])
);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function projectName(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const name = {};
  for (const key of ['am', 'en', 'om']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      name[key] = value[key].trim();
    }
  }
  return name;
}

export function normalizeCashierInterval(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  return INTERVAL_LOOKUP.get(normalized) || null;
}

export function parseCashierReportQuery(searchParams, now = new Date()) {
  const rawFrom = searchParams.get('from');
  const rawTo = searchParams.get('to');
  if (rawFrom && !validateDateString(rawFrom)) {
    return { ok: false, status: 400, error: 'Invalid from date (YYYY-MM-DD)' };
  }
  if (rawTo && !validateDateString(rawTo)) {
    return { ok: false, status: 400, error: 'Invalid to date (YYYY-MM-DD)' };
  }

  const rawInterval = searchParams.get('interval');
  const normalizedInterval = rawInterval == null ? null : normalizeCashierInterval(rawInterval);
  if (rawInterval != null && !normalizedInterval) {
    return { ok: false, status: 400, error: 'Invalid interval' };
  }

  const { from, to, prevFrom, interval } = resolveReportRange(searchParams, now);
  if (!from || !to || from.getTime() >= to.getTime()) {
    return { ok: false, status: 400, error: 'Invalid date range' };
  }
  if (to.getTime() - from.getTime() > CASHIER_MAX_REPORT_DAYS * DAY_MS) {
    return { ok: false, status: 400, error: 'Date range too large' };
  }

  return {
    ok: true,
    from,
    to,
    prevFrom,
    interval: normalizedInterval || interval,
  };
}

export function buildCashierMenuItemPerformance(orders) {
  const items = new Map();
  const seenLines = new Set();

  for (const order of Array.isArray(orders) ? orders : []) {
    const status = String(order?.status || '').toUpperCase();
    if (!FULFILLED_STATUSES.has(status)) continue;
    const orderKey = order?.orderNumber
      ? `number:${order.orderNumber}`
      : order?._id
        ? `id:${order._id}`
        : null;
    if (!orderKey) continue;

    for (let index = 0; index < (Array.isArray(order.items) ? order.items.length : 0); index += 1) {
      const item = order.items[index];
      if (!item || item.cancelled === true) continue;
      const nameText = displayName(item.name, 'en').trim();
      if (!nameText) continue;
      const category = resolveItemType(item);
      if (!category) continue;

      const lineKey = `${orderKey}:${item.lineId ? String(item.lineId) : index}`;
      if (seenLines.has(lineKey)) continue;
      seenLines.add(lineKey);

      const key = `${category}:${nameText}`;
      let entry = items.get(key);
      if (!entry) {
        entry = {
          key,
          name: projectName(item.name),
          category,
          units: 0,
          orderCount: 0,
          paidRevenue: 0,
          orderKeys: new Set(),
        };
        items.set(key, entry);
      }

      entry.units += finiteNumber(item.quantity);
      if (!entry.orderKeys.has(orderKey)) {
        entry.orderKeys.add(orderKey);
        entry.orderCount += 1;
      }
      if (status === 'PAID') entry.paidRevenue += activeItemAmount(item);
    }
  }

  return Array.from(items.values())
    .map(({ orderKeys, ...item }) => ({
      ...item,
      units: Math.round(item.units * 100) / 100,
      paidRevenue: roundMoney(item.paidRevenue),
    }))
    .sort((a, b) => b.units - a.units || displayName(a.name, 'en').localeCompare(displayName(b.name, 'en')));
}

export function projectCashierReportResponse(report, orders) {
  return {
    range: report?.range ?? null,
    revenue: {
      total: report?.kpis?.revenue ?? 0,
      food: report?.kpis?.foodRevenue ?? 0,
      drink: report?.kpis?.drinkRevenue ?? 0,
      unattributed: report?.kpis?.unattributedItemRevenue ?? 0,
    },
    menuItems: buildCashierMenuItemPerformance(orders),
  };
}
