import mongoose from "mongoose";
import { setDbHealth } from "./dbHealth";

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

// One-time, NON-BLOCKING index provisioning. Runs in the background after the
// first successful connect so the first HTTP request is never held up by
// schema-sync work (previously `await Order.syncIndexes()` blocked the first
// verify-pin for seconds — the #1 cause of the 5.0s 503).
async function syncIndexesInBackground(conn) {
  if (cached.indexSyncStarted) return;
  cached.indexSyncStarted = true;
  try {
    const { getOrderModel } = await import("./models/Order");
    const { getSystemAuthModel } = await import("./models/SystemAuth");
    const { getStaffModel } = await import("./models/Staff");
    const { getCategoryModel } = await import("./models/Category");
    const { getMenuItemModel } = await import("./models/MenuItem");
    await Promise.all([
      getOrderModel(conn).syncIndexes(),
      getSystemAuthModel(conn).syncIndexes(),
      getStaffModel(conn).syncIndexes(),
      getCategoryModel(conn).syncIndexes(),
      getMenuItemModel(conn).syncIndexes(),
    ]);
  } catch (error) {
    console.warn("[mongodb] background index sync skipped:", error.message);
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

  // Fire-and-forget schema index sync — never blocks the hot path.
  void syncIndexesInBackground(cached.conn);

  return cached.conn;
}