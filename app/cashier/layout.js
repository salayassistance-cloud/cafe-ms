import { getPortalSession } from "@/lib/authServer";
import PinGuard from "@/app/components/PinGuard";

export const dynamic = "force-dynamic";

// Server-side guard for Cashier portal — reuses existing MANAGER authorization.
// Payment recording (PATCH /api/orders/[id] {status:"PAID"}) requires WAITER/MANAGER
// per lib/policy MATRIX; cashier has no new role. MANAGER is the cashier principal
// for Phase 1 (read-only bill review + authorized settlement). No new backend.

export default async function CashierLayout({ children }) {
  const session = await getPortalSession("MANAGER");
  if (!session) return <PinGuard role="MANAGER" next="/cashier" />;
  return children;
}
