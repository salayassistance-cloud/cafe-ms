import crypto from "crypto";
import mongoose from "mongoose";

import {
  HOTEL_DB_NAME,
} from "../constants.js";
import {
  isHotelMongoUriConfigured,
  requireHotelMongoUri,
} from "../config.js";

// A dedicated Mongoose connection for the Hotel database. It is never the
// default POS connection, and no model is registered on `mongoose.models`.
//
// IMPORTANT: calling this function is always explicit. Importing this module
// must never open a database connection, create a collection, or build an
// index. `autoIndex` and `autoCreate` are disabled so normal application use
// cannot mutate the live schema; index deployment is a separate, approved
// operation.

const GLOBAL_KEY = "__bonoHotelMongooseConnection";

function assertServerOnly() {
  if (typeof window !== "undefined") {
    throw new Error("The Hotel database connection is server-only");
  }
}

const HOTEL_CONNECT_OPTIONS = Object.freeze({
  dbName: HOTEL_DB_NAME,
  appName: "bono-hotel",
  autoIndex: false,
  autoCreate: false,
  bufferCommands: false,
  maxPoolSize: 10,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 30000,
  connectTimeoutMS: 30000,
  socketTimeoutMS: 45000,
});

function getHotelMongoUri() {
  return requireHotelMongoUri();
}

// Keep only a one-way fingerprint in global state. The URI (which may contain
// credentials) is passed to Mongoose but never stored on globalThis.
function uriFingerprint(uri) {
  return crypto.createHash("sha256").update(uri).digest("hex");
}

function getState() {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = {
      connection: null,
      promise: null,
      uriFingerprint: null,
    };
  }
  return globalThis[GLOBAL_KEY];
}

function resetState(state) {
  state.connection = null;
  state.promise = null;
  state.uriFingerprint = null;
}

export function isHotelDatabaseConfigured() {
  return isHotelMongoUriConfigured();
}

export function getHotelDatabaseName() {
  return HOTEL_DB_NAME;
}

export async function connectToHotelDatabase(options = {}) {
  assertServerOnly();
  const uri = getHotelMongoUri();
  const fingerprint = uriFingerprint(uri);
  const state = getState();

  if (
    state.connection &&
    state.uriFingerprint === fingerprint &&
    state.connection.readyState === 1
  ) {
    return state.connection;
  }

  if (state.promise && state.uriFingerprint === fingerprint) {
    return state.promise;
  }

  // A stale/disconnected connection or a changed URI must not be reused.
  // Clear state before connecting so a failed attempt can be retried cleanly.
  if (state.connection) {
    const stale = state.connection;
    resetState(state);
    await stale.close().catch(() => {});
  } else {
    resetState(state);
  }

  state.uriFingerprint = fingerprint;

  const envTimeout = Number(process.env.HOTEL_SERVER_SELECTION_TIMEOUT_MS);
  const serverSelectionTimeoutMS =
    Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      : options.serverSelectionTimeoutMS || HOTEL_CONNECT_OPTIONS.serverSelectionTimeoutMS;

  const connection = mongoose.createConnection(uri, {
    ...HOTEL_CONNECT_OPTIONS,
    ...(options || {}),
    serverSelectionTimeoutMS,
  });
  state.connection = connection;

  // Mongoose emits later topology errors on the connection object. Without a
  // listener Node may treat them as unhandled. Query callers still receive the
  // actual error; never log the URI or credentials here.
  connection.on("error", () => {});

  const pending = connection
    .asPromise()
    .then((connected) => {
      if (state.connection === connected) {
        state.promise = null;
      }
      return connected;
    })
    .catch(async (error) => {
      if (state.connection === connection) {
        resetState(state);
      }
      await connection.close().catch(() => {});
      throw error;
    });

  state.promise = pending;
  return pending;
}

// Intended for explicit shutdown hooks and DB-free integration harnesses.
// Never call this during normal request handling.
export async function disconnectHotelDatabase() {
  assertServerOnly();
  const state = globalThis[GLOBAL_KEY];
  if (!state) return;

  const connection = state.connection;
  const pending = state.promise;
  resetState(state);

  if (pending) {
    await pending.catch(() => {});
  }
  if (connection) {
    await connection.close().catch(() => {});
  }
}
