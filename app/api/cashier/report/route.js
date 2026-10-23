import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { checkRateLimit, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";
import { getReport } from "@/lib/reportService";
import { getOrderModel } from "@/lib/models/Order";
import { parseCashierReportQuery, projectCashierReportResponse } from "@/lib/cashierReport";

export const dynamic = "force-dynamic";

async function handler(request) {
  const rl = checkRateLimit(request, { key: "cashier_report", limit: 30, windowMs: 60_000 });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }

  const auth = await requireAuth(request, ["CASHIER"]);
  if (!auth.ok) return fail(auth.error, auth.status, auth.code);

  const { searchParams } = new URL(request.url);
  const parsed = parseCashierReportQuery(searchParams);
  if (!parsed.ok) return fail(parsed.error, parsed.status);

  const { from, to, prevFrom, interval } = parsed;
  const bypassCache = searchParams.get("fresh") === "1";

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database connection error. Please retry shortly.", 503);
  }

  const report = await getReport(conn, { from, to, prevFrom, interval }, { bypassCache });
  const Order = getOrderModel(conn);
  const orders = await Order.find({ createdAt: { $gte: from, $lt: to } })
    .select("orderNumber status items")
    .lean();

  return ok(projectCashierReportResponse(report, orders), 200);
}

export const GET = withApi(handler);
