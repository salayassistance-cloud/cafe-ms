// In-memory stand-in for lib/hotel/db/connection.js, used only by
// hotel-route behavior tests. A test installs a fake connection on globalThis
// before importing a Route Handler; the handler's lazy dynamic import resolves
// here instead of opening a real MongoDB connection.

const KEY = "__bonoHotelFakeConnection";

export function setHotelFakeConnection(connection) {
  globalThis[KEY] = connection;
  return connection;
}

export function clearHotelFakeConnection() {
  delete globalThis[KEY];
}

export function isHotelDatabaseConfigured() {
  return Boolean(globalThis[KEY]);
}

export function isHotelMongoUriConfigured() {
  return Boolean(globalThis[KEY]);
}

export function requireHotelMongoUri() {
  if (!globalThis[KEY]) throw new Error("Hotel fake connection is not configured");
  return "mongodb://fake-hotel.invalid:27017/bono_hotel";
}

export async function connectToHotelDatabase() {
  const connection = globalThis[KEY];
  if (!connection) throw new Error("Hotel fake connection is not configured");
  return connection;
}

export function assertHotelDatabaseConfigured() {
  return true;
}
