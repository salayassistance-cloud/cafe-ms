import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleListReservationStays } from "@/lib/hotel/http/stayHandlers";

// Hotel-only stay history for one reservation.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleListReservationStays);
