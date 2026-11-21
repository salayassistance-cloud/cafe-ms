import { withHotelApi } from "@/lib/hotel/http/apiResponse";
import { handleCheckOutStay } from "@/lib/hotel/http/stayHandlers";

// Hotel-only check-out endpoint. Only an IN_HOUSE stay can be checked out. The
// room moves to CLEANING, never directly to AVAILABLE.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withHotelApi(handleCheckOutStay);
