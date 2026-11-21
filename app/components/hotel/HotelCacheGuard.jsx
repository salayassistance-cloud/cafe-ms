"use client";

// Back/forward-cache protection for protected Hotel pages.
//
// Protected HTML is served with no-store (see next.config.mjs), which keeps it
// out of HTTP caches. Some browsers can still restore a page from their
// back/forward cache without a network request. On such a restore, ask the
// server layout to re-validate the Hotel cookie: a signed-out session is
// replaced by the correct sign-in gate instead of showing stale protected data.
//
// This component renders nothing and makes no authorization decision; the
// server layout and API guards remain authoritative.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HotelCacheGuard() {
  const router = useRouter();

  useEffect(() => {
    function onPageShow(event) {
      if (event && event.persisted) router.refresh();
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [router]);

  return null;
}
