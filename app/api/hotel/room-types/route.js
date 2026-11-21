import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import {
  handleCreateRoomType,
  handleListRoomTypes,
} from "@/lib/hotel/http/roomTypeHandlers";

// Hotel-only Room Type collection endpoint. Every request is authenticated
// against the Hotel session and the Hotel role permission matrix.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleListRoomTypes);
export const POST = withHotelApi(handleCreateRoomType);
