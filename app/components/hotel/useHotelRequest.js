"use client";

// Shared Hotel API request hook.
// NOTE: Hotel authentication and session CSRF enforcement have been removed.

import { useCallback } from "react";
import { hotelRequest } from "./hotelApi";

export function useHotelRequest() {
  return useCallback(
    async (path, options = {}) => hotelRequest(path, options),
    []
  );
}
