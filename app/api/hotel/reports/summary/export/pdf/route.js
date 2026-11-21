import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleHotelReportsSummaryExportPdf } from "@/lib/hotel/http/reportHandlers";

// Hotel-only manager report summary export (A4 PDF). Same filter, permission,
// and aggregation service as the JSON summary and CSV export; the renderer is
// presentation-only and monochrome.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleHotelReportsSummaryExportPdf);
