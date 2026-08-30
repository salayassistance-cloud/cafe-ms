import { getPortalSession } from "@/lib/authServer";
import PinGuard from "@/app/components/PinGuard";

export const dynamic = "force-dynamic";

// Server-side route guard for the Kitchen (KDS) portal.

export default async function KdsLayout({ children }) {
  const session = await getPortalSession("KITCHEN");
  if (!session) return <PinGuard role="KITCHEN" next="/kds" />;
  return children;
}
