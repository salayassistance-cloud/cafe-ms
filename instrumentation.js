import { connectToDatabase } from "./lib/mongodb";

// Process-level resilience hook. Route-level DB failures are handled by
// lib/withApi (structured 503) and UI errors by app/global-error.js, so this
// file intentionally stays minimal. It is the designated place to register
// global listeners (tracing, metrics) once the server boots.
// Unified DB: single MONGODB_URI powers Category/MenuItem (manager/menu-crud) and orders/auth.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Warm the unified MongoDB connection at boot so the first request to
  // /api/menu, /api/orders, /api/auth etc never pays the ~4s cold-start cost.
  connectToDatabase()
    .then(() => console.log("[instrumentation] db connection warmed (unified)."))
    .catch((e) =>
      console.warn("[instrumentation] db warm-up skipped:", e.message)
    );
  // Extend here with tracing/metrics exporters as needed. Request and render
  // error handling is already covered by withApi + global-error.
}
