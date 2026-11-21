import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import {
  handleGetRoom,
  handleUpdateRoom,
} from "@/lib/hotel/http/roomHandlers";

// Hotel-only Room detail endpoint. Operational status is changed through the
// dedicated status endpoint, and there is no hard-delete handler.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleGetRoom);
export const PATCH = withHotelApi(handleUpdateRoom);
