import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleGetHotelPayment } from "@/lib/hotel/http/paymentHandlers";

// Hotel-only payment detail, including a compact folio summary.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleGetHotelPayment);
