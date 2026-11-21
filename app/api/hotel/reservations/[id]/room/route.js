import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleAssignReservationRoom } from "@/lib/hotel/http/reservationHandlers";

// Hotel-only Reservation room-assignment endpoint. The room must be active,
// belong to the reservation's room type, fit the party, and have no overlapping
// active reservation.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withHotelApi(handleAssignReservationRoom);
