import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleVoidHotelPayment } from "@/lib/hotel/http/paymentHandlers";

// Hotel-only non-destructive void. The payment row is retained as VOIDED and
// the folio is recalculated. There is no amount/method edit route.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withHotelApi(handleVoidHotelPayment);
