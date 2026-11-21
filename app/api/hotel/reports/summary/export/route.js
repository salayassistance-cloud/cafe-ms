import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleHotelReportsSummaryExport } from "@/lib/hotel/http/reportHandlers";

// Hotel-only manager report summary export (CSV). Same filter, permission, and
// aggregation service as the JSON summary; server-rendered RFC 4180 output.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleHotelReportsSummaryExport);
