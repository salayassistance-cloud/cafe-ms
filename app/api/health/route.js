import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { buildHealthPayload, healthStatusCode } from "@/lib/health";
import { validateRuntimeEnv } from "@/lib/config/runtimeEnv";

export const dynamic = "force-dynamic";

function respond(payload, status) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

// GET /api/health          -> readiness (process + database reachability)
// GET /api/health?live=1   -> liveness only (never touches the database)
//
// Public by design: it returns only coarse state. It never exposes database
// names, hosts, driver errors, stack traces, secrets, or environment values.
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const liveOnly = ["1", "true", "yes"].includes(
    String(searchParams.get("live") || "").toLowerCase()
  );

  if (liveOnly) {
    return respond(
      {
        ...buildHealthPayload({ dbReady: false, uptimeSeconds: process.uptime() }),
        status: "alive",
        checks: {},
      },
      200
    );
  }

  const env = validateRuntimeEnv();
  if (!env.ok) {
    return respond(buildHealthPayload({ dbReady: false, uptimeSeconds: process.uptime() }), 503);
  }

  let dbReady = false;
  try {
    const conn = await connectToDatabase();
    dbReady = conn?.readyState === 1;
  } catch {
    dbReady = false;
  }

  const payload = buildHealthPayload({ dbReady, uptimeSeconds: process.uptime() });
  return respond(payload, healthStatusCode(payload));
}
