// Canonical Reporting service — ONE implementation for all manager dashboards.
// Wraps lib/analytics buildReport and centralizes date parsing, limits and caching.
//
// Previous duplication: /api/manager/analytics and /api/manager/reports were
// identical (parseDate → find limit 5000 → buildReport). This module is the
// canonical entry; both route handlers now delegate here.

import { buildReport } from "@/lib/analytics";
import { getOrderModel } from "@/lib/models/Order";

// Keep parseDate logic identical to existing routes (local-midnight construction
// to avoid UTC-shift bug). Shared so both endpoints remain compatible.
export function parseDate(value, endOfDay = false) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d;
}

// Windowing: reports cover [from, to), with prevFrom for delta comparison.
// Returns { from, to, prevFrom } with defaults (last 7 days).
export function resolveReportRange(searchParams, now = new Date()) {
  const to = parseDate(searchParams.get("to"), true) || new Date(now);
  to.setHours(23, 59, 59, 999);
  let from = parseDate(searchParams.get("from"), false);
  if (!from) {
    from = new Date(to);
    from.setDate(from.getDate() - 7);
    from.setHours(0, 0, 0, 0);
  }
  const rangeMs = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - rangeMs);
  const interval = searchParams.get("interval") || "daily";
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
