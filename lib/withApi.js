import { fail, isDbError } from "./apiResponse";
import { getDbHealth, setDbHealth } from "./dbHealth";
import { corsHeaders, handleCorsPreflight } from "./security";

// Wraps a Route Handler so every response (success or failure) is emitted with
// the standardized { success, data, error } envelope. DB connection errors are
// mapped to a graceful 503; everything else to a 500.
//
// Health short-circuit: if the bono connection is known "down", we fast-fail
// without waiting for serverSelectionTimeout (3s). The down flag auto-expires
// after 5s (see lib/dbHealth), so the next request will attempt a fresh
// connect — preventing the self-perpetuating 503 loop where every request
// returned in ~30ms without ever retrying the database.
//
//   export const POST = withApi(async (request) => { ... })
export function withApi(handler, { requireDb = true } = {}) {
  return async function wrapped(request, context) {
    // CORS preflight
    const preflight = handleCorsPreflight(request);
    if (preflight) return preflight;

    const cors = corsHeaders(request);
    const attachCors = (res) => {
      try {
        for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      } catch {}
      return res;
    };

    // Health fast-fail removed: previously a single transient DB blip set
    // getDbHealth() to "down" and then every request within 5s returned an
    // instant 503 without ever attempting to reconnect — amplifying a
    // momentary hiccup into a visible outage (30–280ms 503 storms). Now we
    // always attempt the handler; only an actual thrown DbError becomes 503.
    // The health flag is still updated for observability, but never short-circuits.
    try {
      const result = await handler(request, context);
      return attachCors(result);
    } catch (err) {
      if (isDbError(err)) {
        try {
          setDbHealth("down");
        } catch {}
        console.warn("[api] db error mapped to 503:", err?.message || err);
        const res = fail("Database connection error. Please retry shortly.", 503);
        try {
          res.headers.set("Retry-After", "2");
        } catch {}
        return attachCors(res);
      }
      // Never leak stack traces to client - log server-side, return generic 500
      console.error("[api] unhandled error:", err?.stack || err);
      return attachCors(fail("Internal Server Error", 500));
    }
  };
}
