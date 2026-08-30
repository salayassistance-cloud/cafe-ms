"use client";

import { useEffect, useRef } from "react";

// Client-side hook for the /api/events Server-Sent Events stream.
//
// Calls `onEvent(event)` for every parsed message (heartbeat "ping" frames are
// filtered out). Native EventSource auto-reconnects on drops; consumers keep a
// slow polling fallback so any event missed during a brief disconnect is
// reconciled within a few seconds.

export function useOrderEvents(onEvent) {
  const handlerRef = useRef(onEvent);

  // Keep the latest callback without re-establishing the SSE connection.
  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let es = null;
    try {
      es = new EventSource("/api/events");
    } catch {
      // SSE unavailable (old browser / blocked) — polling fallback covers it.
      return;
    }

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && typeof data === "object" && data.type !== "ping") {
          handlerRef.current?.(data);
        }
      } catch {
        /* malformed frame — ignore; polling covers it */
      }
    };

    return () => {
      es.close();
    };
  }, []);
}
