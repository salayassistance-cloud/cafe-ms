import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleGetStayFolio } from "@/lib/hotel/http/paymentHandlers";

// Hotel-only folio read. The folio is computed from the Stay's finalized
// charge snapshot and persisted HotelPayment records.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleGetStayFolio);
