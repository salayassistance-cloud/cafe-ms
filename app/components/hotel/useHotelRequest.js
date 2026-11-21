"use client";

// Shared request wrapper for the three protected Hotel destinations.
//
// The /hotel server layout already verified any existing session and the CSRF
// token is held in the layout-scoped provider (memory only). This hook reuses
// both: no per-page session bootstrap request and no client-side auth state
// machine. On an expired session it asks the server layout to re-validate,
// which renders the neutral sign-in-unavailable gate. It never logs in.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { hotelRequest } from "./hotelApi";
import { useHotelSession } from "./HotelSessionProvider";

export function useHotelRequest() {
  const router = useRouter();
  const session = useHotelSession();

  return useCallback(
    async (path, options = {}) => {
      try {
        return await hotelRequest(path, {
          ...options,
          csrfToken: session?.csrfToken || null,
        });
      } catch (error) {
        if (error?.status === 401) {
          // Server layout owns the gate; let it re-read the Hotel cookie.
          router.refresh();
        }
        throw error;
      }
    },
    [router, session]
  );
}
