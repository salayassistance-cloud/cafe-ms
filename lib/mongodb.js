import mongoose from "mongoose";
import { setDbHealth } from "./dbHealth";
import { logEvent } from "./operationalLogger";

const MONGODB_URI = process.env.MONGODB_URI;

// Global singleton for the dedicated bono/orders connection (orders, system
// auth, settings). Cached on `globalThis` so every serverless handler and the
// SSE layer share ONE connection + pool instead of spawning per-request
// handshakes that blow past the platform's 5s gateway deadline.
//
// Uses `globalThis` (not `global`) for Node 18+ / Edge compatibility and for
// Next.js dev HMR where `global` may be reset between hot reloads. The cached
// object survives HMR and serverless warm starts, preventing connection leaks.
//
// NOTE: Unified single database connection for ALL collections (orders, auth
// AND menu Category/MenuItem). Previously menu used a separate
// lib/menuConnect.js read-only connection; now all share this
// `createConnection` pool pointing at the same MONGODB_URI so /menu,
// /waiter and /manager/menu-crud are guaranteed single source of truth.
const g = globalThis;
let cached = g.mongoose;

if (!cached) {
  cached = g.mongoose = { conn: null, promise: null, indexSyncStarted: false, listenersAttached: false };
}
// Ensure legacy `global.mongoose` (used before globalThis migration) stays in sync
if (typeof global !== "undefined" && !global.mongoose) {
  global.mongoose = cached;
}

const CONNECT_OPTS = {
  // Never buffer commands: if the connection isn't ready, fail fast instead of
  // silently queueing operations that can hang a request past the 5s deadline.
  bufferCommands: false,
  // Re-use up to 10 connections (Atlas M0/network defaults are fine with this).
  maxPoolSize: 10,
  minPoolSize: 0,
  // Aggressive fast-fail: bail out of server selection after 3s so a cold
  // start or unreachable Atlas returns a clean 503 well before the gateway's
  // 5.0s timeout instead of hanging the request.
  serverSelectionTimeoutMS: 3000,
  // Bound every operation so a stalled command fails cleanly instead of
  // wedging the caller indefinitely (driver default is 0 = no timeout).
  socketTimeoutMS: 30000,
  connectTimeoutMS: 10000,
  family: 4,
};

// Phase 2.2 — index lifecycle is EXPLICIT, not schema-sync.
//
// Before Phase 2.2 this function called `syncIndexes()` for five models. That
// operation creates missing indexes AND DROPS indexes that are not present in
// the current schema, so a routine connection (including a rolling deploy of
// an older/newer build) could silently remove a production index outside any
// approval process. It also ran before the database team could review it.
//
// Replacement:
//   * production: no automatic index work at all. Deploy indexes with the
//     guarded `scripts/sync-indexes.js --confirm` command (additive
//     `createIndexes()` only; it never drops).
//   * non-production (or `POS_AUTO_INDEXES=1`): additive `createIndexes()`
//     only, for developer convenience. It never drops or rebuilds indexes.
//
// `syncIndexes()` must not return to the request/connection path.
function autoIndexProvisioningEnabled() {
  const raw = String(process.env.POS_AUTO_INDEXES ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(raw)) return false;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  // Default: on outside production, off in production.
  return String(process.env.NODE_ENV ?? "").trim().toLowerCase() !== "production";
}

// One-time, NON-BLOCKING, ADDITIVE index provisioning. Runs after the first
// successful connect so the first HTTP request is never held up. Only
// `createIndexes()` is used: no drop, no rebuild, no destructive sync.
async function ensureIndexesInBackground(conn) {
  if (cached.indexSyncStarted) return;
  cached.indexSyncStarted = true;
  if (!autoIndexProvisioningEnabled()) return;
  try {
    const { getOrderModel } = await import("./models/Order");
    const { getStaffModel } = await import("./models/Staff");
    const { getCategoryModel } = await import("./models/Category");
    const { getMenuItemModel } = await import("./models/MenuItem");
    const { getInventoryAuditModel } = await import("./models/InventoryAudit");
    // AUTH-ARCH-8F: SystemAuth is retired as runtime authority (model file
    // retained for explicit ops scripts only). It is intentionally excluded
    // here — existing indexes are untouched, no data writes occur, and scripts
    // import the model directly when needed.
    await Promise.all([
      getOrderModel(conn).createIndexes(),
      getStaffModel(conn).createIndexes(),
      getCategoryModel(conn).createIndexes(),
      getMenuItemModel(conn).createIndexes(),
      getInventoryAuditModel(conn).createIndexes(),
    ]);
  } catch (error) {
    // A failed additive build (e.g. duplicate values for a new unique index)
    // leaves existing indexes untouched. Surface it as an alertable event; do
    // not retry in the background and never drop anything.
    logEvent("warn", "pos_index_provision_failed", {
      errorName: error?.name,
      errorMessage: error?.message || String(error),
      errorCode: error?.code,
    });
  }
}

export default connectToDatabase;
export async function connectToDatabase() {
  // Reuse live connection (readyState 1 = connected). In serverless, the
  // cached object survives warm starts; checking readyState prevents handing
  // a disconnected handle to the caller (which would immediately throw
  // "topology closed" and surface as a 503).
  if (cached.conn) {
    const state = cached.conn.readyState;
    if (state === 1) {
      return cached.conn;
    }
    if (state === 2 && cached.promise) {
      // Still connecting — await the in-flight promise instead of spawning
      // a second handshake that would exhaust the pool.
      try {
        cached.conn = await cached.promise;
        if (cached.conn.readyState === 1) return cached.conn;
      } catch {
        // fall through to reconnect
      }
    }
    // 0 = disconnected, 3 = disconnecting, 99 = uninitialized → clear
    if (state === 0 || state === 3 || state === 99) {
      cached.conn = null;
      cached.promise = null;
      cached.listenersAttached = false;
      setDbHealth("down");
    }
  }

  if (!cached.promise) {
    if (!MONGODB_URI) {
      throw new Error("MONGODB_URI is not set — add it to .env.local");
    }
    cached.promise = mongoose.createConnection(MONGODB_URI, CONNECT_OPTS).asPromise();
  }

  try {
    cached.conn = await cached.promise;
  } catch (error) {
    // Reset the cached promise so the next request retries a fresh connect
    // instead of replaying a rejected (never-resolving) promise.
    cached.promise = null;
    cached.conn = null;
    cached.listenersAttached = false;
    setDbHealth("down");
    throw error;
  }

  // Attach health listeners once per process to avoid duplicate handlers on
  // every hot reload / reconnect. Also handle "close" which some drivers emit.
  if (!cached.listenersAttached) {
    cached.listenersAttached = true;
    const onDown = () => {
      setDbHealth("down");
      // Do not null the conn here — readyState will be 0 and the next
      // connectToDatabase call will clear and reconnect. Keeping the handle
      // allows Mongoose internal reconnect logic to attempt recovery.
    };
    const onUp = () => setDbHealth("up");
    cached.conn.on("disconnected", onDown);
    cached.conn.on("close", onDown);
    cached.conn.on("error", onDown);
    cached.conn.on("connected", onUp);
    cached.conn.on("reconnected", onUp);
    // Also listen for initial "open" event
    cached.conn.once("open", onUp);
  }
  setDbHealth("up");

  // Fire-and-forget ADDITIVE index provisioning (never drops) — never blocks
  // the hot path. Disabled in production by default; see above.
  void ensureIndexesInBackground(cached.conn);

  return cached.conn;
}