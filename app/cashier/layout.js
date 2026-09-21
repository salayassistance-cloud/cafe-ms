import { getPortalSession } from "@/lib/authServer";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/sessionCrypto";
import { cookies } from "next/headers";
import PinGuard from "@/app/components/PinGuard";

export const dynamic = "force-dynamic";

// Server-side guard for Cashier portal — now CASHIER distinct, MANAGER retained as fallback
// Payment verification: WAITER submits PAYMENT_PENDING, CASHIER (or MANAGER) confirms PAID
// CASHIER cannot access manager-only APIs; WAITER/KITCHEN/BARISTA cannot access Cashier.

export default async function CashierLayout({ children }) {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value || null;
  const payload = token ? verifySessionToken(token) : null;
  const role = payload?.role ? String(payload.role).toUpperCase() : null;
  const isCashier = role === "CASHIER" && payload && (await getPortalSession("CASHIER"));
  const isManager = role === "MANAGER" && payload && (await getPortalSession("MANAGER"));
  if (!isCashier && !isManager) {
    // Prefer CASHIER guard, fallback to MANAGER for Manager override (reported, not strict CASHIER-only)
    // If strict CASHIER-only required, change to PinGuard role="CASHIER" only
    return <PinGuard role="CASHIER" next="/cashier" />;
  }
  return children;
}
