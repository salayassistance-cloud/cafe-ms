import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleListGuestStays } from "@/lib/hotel/http/stayHandlers";

// Hotel-only stay history for one guest.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withHotelApi(handleListGuestStays);
