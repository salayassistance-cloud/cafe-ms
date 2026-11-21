import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleDeactivateRoomType } from "@/lib/hotel/http/roomTypeHandlers";

// Hotel-only Room Type deactivation endpoint. Deactivation is refused while
// active rooms still reference the type. No hard-delete endpoint exists.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withHotelApi(handleDeactivateRoomType);
