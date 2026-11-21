import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import {
  handleCreateRoom,
  handleListRooms,
} from "@/lib/hotel/http/roomHandlers";

// Hotel-only Room collection endpoint. Every request is authenticated against
// the Hotel session and the Hotel role permission matrix.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleListRooms);
export const POST = withHotelApi(handleCreateRoom);
