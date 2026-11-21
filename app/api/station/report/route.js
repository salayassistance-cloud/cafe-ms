import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { checkRateLimit, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";
import { getOrderModel } from "@/lib/models/Order";
import { parseCashierReportQuery } from "@/lib/cashierReport";
import { projectStationReportResponse, stationReportScope } from "@/lib/stationReport";

export const dynamic = "force-dynamic";

// Station-scoped menu-item performance report.
//
// Authorization is role-derived: KITCHEN -> FOOD, BARISTA -> DRINK,
// HOT_DRINK -> HOT_DRINK. No station/role/dest request parameter is read, so a
// station user cannot ask for another station's report by changing the URL.
// Date parsing/validation is the same canonical Cashier helper (Addis business
// days, same presets, same 31-day cap) — the Cashier endpoint itself is not
// touched or reused for authorization.
const STATION_ROLES = ["KITCHEN", "BARISTA", "HOT_DRINK"];
const FULFILLED_STATUSES = ["READY", "SERVED", "PAID"];

async function handler(request) {
  const rl = checkRateLimit(request, { key: "station_report", limit: 30, windowMs: 60_000 });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try {
      res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs)));
    } catch {}
    return res;
  }

  const auth = await requireAuth(request, STATION_ROLES);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);

  // Identity and station come from the authenticated LIVE Staff session only.
  const scope = stationReportScope(auth.payload.role);
  if (!scope) return fail("Forbidden", 403);

  const { searchParams } = new URL(request.url);
  const parsed = parseCashierReportQuery(searchParams);
  if (!parsed.ok) return fail(parsed.error, parsed.status);

  const { from, to, interval } = parsed;

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database connection error. Please retry shortly.", 503);
  }

  try {
    const Order = getOrderModel(conn);
    // Only fulfilled orders can contribute completed item lines, exactly like
    // the Cashier menu-item report. The station partition is applied by the
    // canonical classifier below (item.type -> categoryType fallback), not by
    // a name/category guess and not by a client parameter. One query, no N+1.
    const orders = await Order.find({
      status: { $in: FULFILLED_STATUSES },
      createdAt: { $gte: from, $lt: to },
    })
      .select("orderNumber status items")
      .lean();

    return ok(
      projectStationReportResponse({
        station: scope.station,
        itemType: scope.itemType,
        from,
        to,
        interval,
        orders,
      }),
      200
    );
  } catch (err) {
    if (isDbError(err)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[station-report] failed:", err?.stack || err);
    return fail("Unable to load station report.", 500);
  }
}

export const GET = withApi(handler);
