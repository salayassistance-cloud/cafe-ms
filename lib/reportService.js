// Canonical Reporting service — ONE implementation for all manager dashboards.
// Wraps lib/analytics buildReport and centralizes date parsing, limits and caching.
//
// Previous duplication: /api/manager/analytics and /api/manager/reports were
// identical (parseDate → find limit 5000 → buildReport). This module is the
// canonical entry; both route handlers now delegate here.

import { buildReport, addisWallToUTC, addisYMDToUTCStart, addisYMDToUTCNextStart, getAddisYMD } from "@/lib/analytics";
import { getOrderModel } from "@/lib/models/Order";

// Addis business-day helpers — uses Africa/Addis_Ababa via analytics canonical utilities.
// parseDate interprets YYYY-MM-DD as an Addis wall date and returns the corresponding UTC instant
// (00:00 Addis for start, 23:59:59.999 Addis for endOfDay). No local TZ, no hardcoded offset.
export function parseDate(value, endOfDay = false) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (endOfDay) return addisWallToUTC(y, mo, d, 23, 59, 59, 999);
  return addisWallToUTC(y, mo, d, 0, 0, 0, 0);
}

// Windowing: reports cover [from, to) as half-open Addis business days.
// Returns { from, to, prevFrom } where from is inclusive Addis 00:00, to is exclusive next Addis 00:00.
export function resolveReportRange(searchParams, now = new Date()) {
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  const interval = searchParams.get("interval") ? String(searchParams.get("interval")).toLowerCase() : "daily";
  const valid = (s) => s && /^(\d{4})-(\d{2})-(\d{2})$/.test(String(s).trim());
  let fromYMD = valid(rawFrom) ? String(rawFrom).trim() : null;
  let toYMD = valid(rawTo) ? String(rawTo).trim() : null;
  const addisToday = getAddisYMD(now);
  if (!toYMD) toYMD = addisToday;
  if (!fromYMD) {
    const toStart = addisYMDToUTCStart(toYMD);
    const fromStart = new Date(toStart.getTime() - 7 * 24 * 3600 * 1000);
    fromYMD = getAddisYMD(fromStart);
  }
  const from = addisYMDToUTCStart(fromYMD);
  const to = addisYMDToUTCNextStart(toYMD);
  const rangeMs = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - rangeMs);
  return { from, to, prevFrom, interval };
}

// In-memory cache to avoid hammering DB. Phase 5: TTL 30s (was 5s for 3s poll) — reports are now
// on-demand (60s background) so 30s is safe and reduces DB 10x.
const g = globalThis;
if (!g.__reportCache) g.__reportCache = new Map();
const CACHE_TTL_MS = 30000;

function cacheKey(from, to, interval) {
  return `${from.toISOString()}:${to.toISOString()}:${interval}`;
}

export async function getReport(conn, { from, to, prevFrom, interval }) {
  const key = cacheKey(from, to, interval);
  const hit = g.__reportCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.data;
  }
  const Order = getOrderModel(conn);
  // Single range query covering current + previous window for delta. Phase 5: removed arbitrary
  // .limit(5000) — financial totals must be mathematically correct. For large collections this
  // streams all in-range docs (lean, projection) and buildReport aggregates in JS. If collection
  // grows > 50k per window, migrate to $match+$group aggregation (see note below).
  const orders = await Order.find({ createdAt: { $gte: prevFrom, $lt: to } })
    .select("status kitchenStatus baristaStatus totalAmount createdAt items waiterName waiterId waiterNumber waiterInfo kitchenStaffId baristaStaffId paymentMethod preparingAt readyAt servedAt paidAt completedAt kitchenPreparingAt kitchenReadyAt baristaPreparingAt baristaReadyAt updatedAt isExternal")
    .sort({ createdAt: 1 })
    // No limit — never silently truncate financial reports. Guard against unbounded memory:
    // if orders.length > 50000 we log and consider aggregation migration (not yet needed for POS scale).
    .lean();
  if (orders.length > 50000) {
    console.warn(`[reportService] large window: ${orders.length} orders in range — consider aggregation pipeline`);
  }
  const report = buildReport(orders, from, to, interval);
  g.__reportCache.set(key, { at: Date.now(), data: report });
  // Prune stale entries
  if (g.__reportCache.size > 20) {
    const now = Date.now();
    for (const [k, v] of g.__reportCache.entries()) {
      if (now - v.at > CACHE_TTL_MS * 3) g.__reportCache.delete(k);
    }
  }
  return report;
}

// Optionally enrich kitchen/barista perf with staff names (extra DB round-trip)
export async function enrichWithStaffNames(conn, report) {
  try {
    const { getStaffModel } = await import("@/lib/models/Staff");
    const Staff = getStaffModel(conn);
    const ids = [
      ...new Set([...(report.kitchenPerf || []).map((k) => k.staffId), ...(report.baristaPerf || []).map((b) => b.staffId)]),
    ].filter(Boolean);
    if (!ids.length) return report;
    const docs = await Staff.find({ _id: { $in: ids } }).select("name role").lean();
    const nameMap = new Map(docs.map((s) => [String(s._id), s.name]));
    return {
      ...report,
      kitchenPerf: (report.kitchenPerf || []).map((k) => ({ ...k, name: nameMap.get(k.staffId) || k.staffId })),
      baristaPerf: (report.baristaPerf || []).map((b) => ({ ...b, name: nameMap.get(b.staffId) || b.staffId })),
    };
  } catch {
    return report;
  }
}

// Convenience: fetch with searchParams in one call
export async function getReportFromParams(conn, searchParams) {
  const { from, to, prevFrom, interval } = resolveReportRange(searchParams);
  const report = await getReport(conn, { from, to, prevFrom, interval });
  return { report, from, to, prevFrom, interval };
}
