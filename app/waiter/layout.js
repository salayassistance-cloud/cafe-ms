import { getPortalSession } from "@/lib/authServer";
import PinGuard from "@/app/components/PinGuard";

export const dynamic = "force-dynamic";

// Server-side route guard for the Waiter portal. Renders the full-screen PIN
// guard (waiter-number picker + PIN) instead of the page content whenever the
// signed session cookie is missing or invalid, so the UI can never be bypassed
// by navigating directly to /waiter.

export default async function WaiterLayout({ children }) {
  const session = await getPortalSession("WAITER");
  if (!session) return <PinGuard role="WAITER" next="/waiter" />;
  return children;
}
