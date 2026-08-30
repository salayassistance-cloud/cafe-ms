import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { sanitizeString, validateDateString } from "@/lib/validate";
import { requireAuth } from "@/lib/security";
import { getReport, resolveReportRange } from "@/lib/reportService";

export const dynamic = "force-dynamic";

// GET /api/manager/analytics
// Aggregates interval sales, category velocity, and average KDS preparation
// speed for the Manager Dashboard. Reads the unified Order collection and is the
// canonical analytics endpoint.
//
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&interval=daily|hourly|shift|... (default
// last 7 days, daily).
// Parse a YYYY-MM-DD range bound as a LOCAL calendar day. The ISO-only
// `new Date("YYYY-MM-DD")` form is interpreted as UTC midnight, so applying
// setHours() in local time shifts the window a full day early on servers west
// of UTC (e.g. MDT): "TODAY" would silently report yesterday. Constructing the
// Date from its numeric components keeps the bound on the requested day in
// every timezone, with NO date-shift bugs.
//
// Business-day boundaries follow the server's local timezone, so production
// should run with TZ=Africa/Addis_Ababa (UTC+3, no DST) — "Today" then means
// the Ethiopian business day, as the manager dashboard intends.
// Date parsing canonicalized in lib/reportService (resolveReportRange).

async function handler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  const rl = checkRateLimit(request, { key: "manager_analytics", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  const { searchParams } = new URL(request.url);
  const rawInterval = searchParams.get("interval");
  const intervalRaw = rawInterval ? sanitizeString(rawInterval, { maxLen: 20, allowEmpty: true }) : "daily";
  const interval = intervalRaw ? intervalRaw.toLowerCase() : "daily";
  if (interval && !["daily","hourly","shift","trends","custom","weekly"].includes(interval)) return fail("Invalid interval", 400);
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  if (rawFrom && !validateDateString(rawFrom)) return fail("Invalid from date (YYYY-MM-DD)", 400);
  if (rawTo && !validateDateString(rawTo)) return fail("Invalid to date (YYYY-MM-DD)", 400);

  const { from, to, prevFrom } = resolveReportRange(searchParams);

  let conn;
  try {
    conn = await connectToDatabase();
  } catch {
    return fail("Database connection error. Please retry shortly.", 503);
  }
  const report = await getReport(conn, { from, to, prevFrom, interval });
  return ok(report, 200);
}

export const GET = withApi(handler);
