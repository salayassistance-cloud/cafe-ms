import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import {
  handleCreateGuest,
  handleListGuests,
} from "@/lib/hotel/http/guestHandlers";

// Hotel-only Guest collection endpoint. Every request is authenticated against
// the Hotel session and the Hotel role permission matrix.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleListGuests);
export const POST = withHotelApi(handleCreateGuest);
