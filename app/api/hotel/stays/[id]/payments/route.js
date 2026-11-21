import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleRecordStayPayment } from "@/lib/hotel/http/paymentHandlers";

// Hotel-only payment recording. Only a CHECKED_OUT stay with finalized charges
// can receive a payment. Overpayment is rejected.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withHotelApi(handleRecordStayPayment);
