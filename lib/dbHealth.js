// Tracks the live health of the Bono (orders) database connection so route
// handlers can short-circuit with a structured 503 instead of throwing and
// surfacing an opaque 500 to the Waiter UI, KDS and Manager Dashboard.
//
// The "down" state auto-expires after DOWN_TTL_MS so a transient outage does
// not permanently block retries. With the previous implementation, once health
// flipped to "down" via withApi's pre-handler check, every subsequent request
// returned an instant 503 without ever attempting to reconnect — a
// self-perpetuating failure loop that surfaced as the rapid 30–280ms 503s
// reported in the logs. Now the flag degrades to "unknown" after 5s, allowing
// the next request to attempt a fresh connect.

const globalRef = globalThis;
const DOWN_TTL_MS = 5000;

if (!globalRef._bonoDbHealth) {
  globalRef._bonoDbHealth = { status: "unknown", updatedAt: 0 };
}

export function setDbHealth(status) {
  globalRef._bonoDbHealth.status = status;
  globalRef._bonoDbHealth.updatedAt = Date.now();
}

export function getDbHealth() {
  const { status, updatedAt } = globalRef._bonoDbHealth;
  if (status === "down" && updatedAt && Date.now() - updatedAt > DOWN_TTL_MS) {
    // Expire stale "down" — allow a fresh connection attempt.
    globalRef._bonoDbHealth.status = "unknown";
    return "unknown";
  }
  return status;
}
