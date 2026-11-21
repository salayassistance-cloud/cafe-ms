import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleChangeRoomStatus } from "@/lib/hotel/http/roomHandlers";

// Hotel-only operational status endpoint. Manual changes are limited to
// AVAILABLE, CLEANING, MAINTENANCE, and OUT_OF_SERVICE; OCCUPIED and RESERVED
// are reserved for the future reservation/check-in flow.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withHotelApi(handleChangeRoomStatus);
