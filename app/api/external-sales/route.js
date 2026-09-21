import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { connectToDatabase } from "@/lib/mongodb";
import { getOrderModel } from "@/lib/models/Order";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";

export const dynamic = "force-dynamic";

// POST /api/external-sales — DEPRECATED: Extra Items are now part of normal orders (isExternal:true, routed to Kitchen/Barista and included in revenue)
// Historical orders with isExternal:true remain readable, but new external sales must use POST /api/orders
async function postHandler(request) {
  return fail("External sales are deprecated — add Extra Items to the order instead", 410);
}

export const POST = withApi(postHandler);
