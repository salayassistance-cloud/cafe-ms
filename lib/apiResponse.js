// Standardized JSON envelope for every API route.
// All responses follow: { success: boolean, data: object|null, error: string }.
// Ensures explicit HTTP status codes and never leaks stack traces.

export function ok(data = null, status = 200) {
  // Always no-store for dynamic APIs - enforced via headers in withApi/middleware
  return Response.json({ success: true, data, error: null }, { status });
}

export function fail(error = "Internal Server Error", status = 500) {
  // Sanitize error before leaking to client - never send stack traces
  let message = "Internal Server Error";
  if (error instanceof Error) {
    message = error.message || "Internal Server Error";
    // Strip any stack trace fragments if present
    message = message.split("\n")[0].slice(0, 500);
  } else if (typeof error === "string" && error.trim()) {
    message = error.trim().slice(0, 500);
  }
  // Prevent XSS in error message - strip HTML tags
  message = message.replace(/<[^>]*>/g, "");
  // Envelope includes both `error` (canonical) and `message` (legacy clients: PinGuard checks data?.message)
  return Response.json({ success: false, data: null, error: message, message }, { status });
}

// Created helper for 201
export function created(data = null) {
  return ok(data, 201);
}

// MongoDB / Mongoose failures (server down, auth failure, topology closed,
// server-selection timeout, DNS) should degrade to a 503 so clients can
// retry rather than treat it as an unrecoverable application bug.
export function isDbError(err) {
  if (!err) return false;
  const signature = `${err.name || ""} ${err.message || ""} ${err.code || ""}`;
  return /mongo|mongoose|disconnected|server selection|topology|econnrefused|etimedout|network/i.test(
    signature
  );
}
