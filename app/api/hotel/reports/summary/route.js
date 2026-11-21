import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleHotelReportsSummary } from "@/lib/hotel/http/reportHandlers";

// Hotel-only manager report summary (JSON). Read-only: REPORTS_READ, no CSRF.
// Every metric is aggregated from canonical Hotel records for a bounded
// Addis-Ababa civil-date window.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleHotelReportsSummary);
