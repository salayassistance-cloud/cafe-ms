// Station menu-item performance — ONE pure implementation shared by the
// Kitchen, Barista and Jebena Buna (HOT_DRINK) reports.
//
// Station ownership comes from the persisted item type snapshot
// (`item.type`, falling back to legacy `item.categoryType`) through the same
// canonical classifier the Cashier report uses. Names, menu categories and
// client-supplied station values are never used to decide ownership.
//
// The aggregation itself is the existing Cashier menu-item implementation
// (`buildCashierMenuItemPerformance`): fulfilled orders (READY/SERVED/PAID),
// non-cancelled lines, distinct order keys, historical line prices and
// canonical paid revenue. This module only partitions that canonical result
// by item type, so the station report can never invent a second revenue or
// order-count interpretation.

import { buildCashierMenuItemPerformance } from './cashierReport.js';
import { STATION_ITEM_TYPE, stationForRole } from './stationStatus.js';

export const STATION_REPORT_ITEM_TYPES = Object.freeze(['FOOD', 'DRINK', 'HOT_DRINK']);
export const STATION_REPORT_ROLES = Object.freeze(['KITCHEN', 'BARISTA', 'HOT_DRINK']);

// Authenticated LIVE Staff role -> { station, itemType }. Null for any role
// that does not operate a preparation station. The caller must derive this
// from the session, never from a request parameter.
export function stationReportScope(role) {
  const station = stationForRole(role);
  if (!station) return null;
  const itemType = STATION_ITEM_TYPE[station];
  if (!itemType) return null;
  return { station, itemType };
}

// Filter the canonical Cashier menu-item rows down to one station's persisted
// item type. Rows keep the canonical key/name/units/orderCount/paidRevenue.
export function buildStationMenuItemPerformance(orders, itemType) {
  const type = String(itemType || '').trim().toUpperCase();
  if (!STATION_REPORT_ITEM_TYPES.includes(type)) return [];
  return buildCashierMenuItemPerformance(orders)
    .filter((item) => String(item?.category || '').toUpperCase() === type)
    .map((item) => ({
      key: item.key,
      name: item.name,
      category: item.category,
      units: item.units,
      orderCount: item.orderCount,
      paidRevenue: item.paidRevenue,
    }));
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// Response projection: only the station's aggregated rows and a station-scoped
// total. No order documents, no other station's rows, no cashier KPIs.
export function projectStationReportResponse({ station, itemType, from, to, interval, orders }) {
  const menuItems = buildStationMenuItemPerformance(orders, itemType);
  const totals = menuItems.reduce(
    (acc, item) => {
      acc.units += Number(item.units) || 0;
      acc.revenue += Number(item.paidRevenue) || 0;
      return acc;
    },
    { units: 0, revenue: 0 }
  );

  return {
    station,
    itemType,
    range: {
      from: from instanceof Date ? from.toISOString() : from,
      to: to instanceof Date ? to.toISOString() : to,
      interval: interval || null,
    },
    menuItems,
    totals: {
      items: menuItems.length,
      units: Math.round(totals.units * 100) / 100,
      revenue: roundMoney(totals.revenue),
    },
  };
}
