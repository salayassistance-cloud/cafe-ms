import { getPortalSession } from "@/lib/authServer";
import PinGuard from "@/app/components/PinGuard";

export const dynamic = "force-dynamic";

// Server-side guard for the Cashier portal — STRICT CASHIER-only.
//
// Forceful role separation: only a LIVE Staff.role === CASHIER session may
// enter /cashier. A MANAGER session is rejected (PinGuard for CASHIER login)
// even though MANAGER remains authorized for the underlying payment-confirm
// BUSINESS operations at the API layer (policy: orders:payment:confirm =
// [CASHIER, MANAGER]) — portal access and business authorization are
// distinct decisions. No identity is ever converted.

export default async function CashierLayout({ children }) {
  const session = await getPortalSession("CASHIER");
  if (!session) {
    return <PinGuard role="CASHIER" next="/cashier" />;
  }
  return children;
}
