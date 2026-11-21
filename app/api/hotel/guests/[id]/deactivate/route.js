import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleDeactivateGuest } from "@/lib/hotel/http/guestHandlers";

// Hotel-only Guest deactivation endpoint. A guest with active reservations
// cannot be deactivated. Guests are never hard-deleted.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withHotelApi(handleDeactivateGuest);
