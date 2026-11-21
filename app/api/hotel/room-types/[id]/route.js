import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import {
  handleGetRoomType,
  handleUpdateRoomType,
} from "@/lib/hotel/http/roomTypeHandlers";

// Hotel-only Room Type detail endpoint. There is intentionally no DELETE
// handler: room types are deactivated so historical rooms keep their reference.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleGetRoomType);
export const PATCH = withHotelApi(handleUpdateRoomType);
