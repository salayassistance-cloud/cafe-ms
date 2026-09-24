"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { PWA_LAST_ROUTE_KEY, sanitizePwaRoute } from "@/lib/pwa";

// Records the current safe pathname per-device so the installed PWA can
// relaunch where it was installed from. Render-only side effect: no UI,
// no navigation change, no auth interaction. Unsafe routes (e.g. /login,
// /launch, /api) are ignored and never overwrite the stored route.
export default function PwaRouteTracker() {
  const pathname = usePathname();

  useEffect(() => {
    try {
      const clean = pathname ? sanitizePwaRoute(pathname) : null;
      if (!clean) return;
      window.localStorage.setItem(PWA_LAST_ROUTE_KEY, clean);
    } catch {
      // Storage unavailable (private mode, etc.) — normal browsing continues.
    }
  }, [pathname]);

  return null;
}
