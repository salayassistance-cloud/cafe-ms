import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleDeactivateRoom } from "@/lib/hotel/http/roomHandlers";

// Hotel-only Room deactivation endpoint. Occupied and reserved rooms cannot be
// deactivated. Rooms are never hard-deleted, preserving historical references.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withHotelApi(handleDeactivateRoom);
