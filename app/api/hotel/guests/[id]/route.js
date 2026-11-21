import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import {
  handleGetGuest,
  handleUpdateGuest,
} from "@/lib/hotel/http/guestHandlers";

// Hotel-only Guest detail endpoint. There is no hard-delete handler.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleGetGuest);
export const PATCH = withHotelApi(handleUpdateGuest);
