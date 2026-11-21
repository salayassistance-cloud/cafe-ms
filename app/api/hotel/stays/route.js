import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleListStays } from "@/lib/hotel/http/stayHandlers";

// Hotel-only Stay history endpoint. Stays are never hard-deleted.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleListStays);
