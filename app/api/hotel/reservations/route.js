import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import {
  handleCreateReservation,
  handleListReservations,
} from "@/lib/hotel/http/reservationHandlers";

// Hotel-only Reservation collection endpoint. Room inventory is protected by a
// per-room booking lock; overlapping active reservations are rejected.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleListReservations);
export const POST = withHotelApi(handleCreateReservation);
