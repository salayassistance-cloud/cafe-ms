import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import {
  handleGetReservation,
  handleUpdateReservation,
} from "@/lib/hotel/http/reservationHandlers";

// Hotel-only Reservation detail endpoint. Status and room changes use their
// dedicated workflows; there is no hard-delete handler.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleGetReservation);
export const PATCH = withHotelApi(handleUpdateReservation);
