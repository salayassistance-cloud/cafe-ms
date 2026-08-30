// In-process pub/sub hub for order-change events (server-only).
//
// Every order mutation (POST /api/orders, PATCH/DELETE /api/orders/[id])
// publishes a lightweight "orders-changed" event. Connected terminals receive
// it over the /api/events SSE stream and refetch their feed immediately —
// replacing the old 3-second polling with push-based real-time updates.
//
// Single-process design: this cafe POS runs one Node server, so an in-memory
// hub is sufficient and needs no Redis / socket server. If the app is ever
// deployed across multiple server instances, swap this module for a shared
// pub/sub transport (e.g. Redis) — the subscribe/publish API stays the same.
//
// Stored on globalThis so dev hot-reloads don't orphan live SSE connections.

const globalRef = globalThis;

if (!globalRef.__orderEventHub) {
  globalRef.__orderEventHub = { clients: new Set() };
}

const hub = globalRef.__orderEventHub;

// Register a stream writer. Returns an unsubscribe function.
export function subscribe(send) {
  hub.clients.add(send);
  return () => hub.clients.delete(send);
}

// Fan a JSON-serializable event out to every connected terminal. Never
// throws: a dead writer is dropped and the rest still receive the event.
export function publish(event) {
  const payload = JSON.stringify({ ...event, ts: Date.now() });
  for (const send of hub.clients) {
    try {
      send(payload);
    } catch {
      hub.clients.delete(send);
    }
  }
}

// Number of live SSE connections (used for diagnostics).
export function clientCount() {
  return hub.clients.size;
}
