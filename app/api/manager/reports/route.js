import { connectToDatabase } from "@/lib/mongodb";
import { withApi } from "@/lib/withApi";
import { ok, fail } from "@/lib/apiResponse";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { sanitizeString, validateDateString } from "@/lib/validate";
import { requireAuth } from "@/lib/security";
import { getReport, resolveReportRange, enrichWithStaffNames } from "@/lib/reportService";

export const dynamic = "force-dynamic";

// GET /api/manager/reports
// Legacy alias — canonical is /api/manager/analytics (lib/reportService).
// This handler delegates to the same service and adds staff-name enrichment
// for backward-compat. New clients should use /api/manager/analytics.

async function handler(request) {
  // Defense-in-depth: require MANAGER HttpOnly session (layout PinGuard gates pages,
  // but direct API hits must also be blocked — prevents sales data exfiltration).
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  // Rate limit manager APIs
  const rl = checkRateLimit(request, { key: "manager_reports", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  const { searchParams } = new URL(request.url);
  const rawInterval = searchParams.get("interval");
  const intervalRaw = rawInterval ? sanitizeString(rawInterval, { maxLen: 20, allowEmpty: true }) : "daily";
  const interval = intervalRaw ? intervalRaw.toLowerCase() : "daily";
  const allowedIntervals = ["daily","hourly","shift","trends","custom","weekly"];
  if (interval && !allowedIntervals.includes(interval)) {
    return fail("Invalid interval", 400);
  }
  // Validate date params strictly
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
  let report = await getReport(conn, { from, to, prevFrom, interval });
  report = await enrichWithStaffNames(conn, report);
  // Add deprecation header so clients can migrate to /api/manager/analytics
  const res = ok(report, 200);
  try { res.headers.set("Deprecation", "true"); res.headers.set("Sunset", "Thu, 31 Dec 2026 23:59:59 GMT"); } catch {}
  return res;
}

export const GET = withApi(handler);
