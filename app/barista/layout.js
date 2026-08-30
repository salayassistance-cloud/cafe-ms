import { getPortalSession } from "@/lib/authServer";
import PinGuard from "@/app/components/PinGuard";

export const dynamic = "force-dynamic";

// Server-side route guard for the Barista (KDS) portal.

export default async function BaristaLayout({ children }) {
  const session = await getPortalSession("BARISTA");
  if (!session) return <PinGuard role="BARISTA" next="/barista" />;
  return children;
}
