import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleCancelReservation } from "@/lib/hotel/http/reservationHandlers";

// Hotel-only Reservation cancellation endpoint. Cancellation preserves the
// reservation and appends an explicit status-history transition.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withHotelApi(handleCancelReservation);
