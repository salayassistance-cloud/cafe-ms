import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleGetStay } from "@/lib/hotel/http/stayHandlers";

// Hotel-only Stay detail endpoint, including immutable snapshots, status
// history, and (after checkout) the payment-summary boundary.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleGetStay);
