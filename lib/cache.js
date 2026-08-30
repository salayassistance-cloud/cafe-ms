// Canonical Caching policy — documents and implements cache behavior per domain.
//
// Menu / Categories: cacheable, revalidated on mutation (revalidatePath + tags)
// Active Orders: must remain fresh (no-store, SSE invalidation)
// Reports: short-lived in-memory TTL (5s) via reportService
// Auth snapshots: in-memory via authService systemAuthSnapshot
// Brand / PaymentInfo: lightly cacheable (rare mutate)

export const CACHE_TAGS = {
  MENU: "menu",
  CATEGORIES: "categories",
  BRAND: "brand",
  PAYMENT_INFO: "paymentInfo",
};

// Helpers for route handlers / Server Actions to announce invalidation
// Call after any Category/MenuItem mutation; /api/menu consumers will see
// fresh data on next fetch when using next.revalidateTag in fetch options.
// For now we use revalidatePath as the fetch cache is no-store; this prepares
// the tag path for future ISR.
export async function invalidateMenuCaches() {
  try {
    const { revalidatePath, revalidateTag } = await import("next/cache");
    revalidatePath("/menu");
    revalidatePath("/waiter");
    revalidatePath("/manager/menu-crud");
    revalidatePath("/manager/reports");
    revalidatePath("/");
    // Future: tag-based
    try { revalidateTag(CACHE_TAGS.MENU); } catch {}
    try { revalidateTag(CACHE_TAGS.CATEGORIES); } catch {}
  } catch {}
}

// Policy summary for documentation / route comments:
// - menu, brand, payment-info: public READ → allow CDN/browser stale while revalidate 60s; server revalidateTag on write
// - orders ACTIVE: private, no-store, SSE invalidation only
// - reports: private, no-store on client, 5s server cache in reportService
// - auth: HttpOnly cookie + in-memory snapshot (authService) with explicit invalidation on write
