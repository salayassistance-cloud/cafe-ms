import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleCheckInReservation } from "@/lib/hotel/http/stayHandlers";

// Hotel-only check-in endpoint. Only a CONFIRMED reservation with an assigned,
// ready room can be checked in. The operation is idempotent and serialized by
// the per-room booking lock.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withHotelApi(handleCheckInReservation);
