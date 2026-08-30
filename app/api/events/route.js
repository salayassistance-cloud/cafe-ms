import { subscribe } from "@/lib/eventHub";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// GET /api/events
// Server-Sent Events stream. Terminals (KDS / Barista / Waiter) hold this
// connection open; the server pushes lightweight "orders-changed" events the
// moment an order is created or changes status, so boards refresh instantly
// instead of waiting for the next poll.
//
// - Open to any same-origin terminal (no session/auth required).
// - Keep-alive pings every 25s so proxies/browsers never drop the idle stream.
// - Events are invalidations: clients refetch their own feed, so the existing
//   fetch/merge logic (status badges, elapse timers, READY toasts) is reused
//   unchanged and cannot drift from the database.

const PING_MS = 25000;

export async function GET(request) {
  const rl = checkRateLimit(request, { key: "events", ...RATE_LIMITS.GENERAL });
  if (!rl.ok) {
    return new Response("Too many requests. Please slow down.", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
    });
  }
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Register this client; unsubscribes on disconnect.
      const unsubscribe = subscribe(send);

      // Keep-alive heartbeat so idle connections survive proxies/browsers.
      const ping = setInterval(
        () => send(JSON.stringify({ type: "ping" })),
        PING_MS
      );

      // Cleanup when the client goes away or the request is aborted.
      const onAbort = () => {
        closed = true;
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* stream already closed */
        }
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      // Flush an opening comment so the stream is live immediately.
      try {
        controller.enqueue(encoder.encode(`: connected\n\n`));
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
