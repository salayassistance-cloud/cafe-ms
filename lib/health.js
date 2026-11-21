// Phase 2.2 — health payload builder (pure, dependency-free).
//
// The public health endpoint must expose only coarse state. Never include a
// connection string, error message, stack trace, host name, or environment
// value. Readiness means "the process can reach its database"; liveness is
// simply "the process answered".

export function buildHealthPayload({ dbReady, now = new Date(), uptimeSeconds = 0 } = {}) {
  const ready = dbReady === true;
  return {
    service: "bono-pos",
    status: ready ? "ready" : "not_ready",
    checks: {
      database: ready ? "up" : "down",
    },
    uptimeSeconds: Math.max(0, Math.floor(Number(uptimeSeconds) || 0)),
    timestamp: now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString(),
  };
}

export function healthStatusCode(payload) {
  return payload?.status === "ready" ? 200 : 503;
}
