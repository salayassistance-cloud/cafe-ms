import { getPortalSession } from "@/lib/authServer";
import PinGuard from "@/app/components/PinGuard";

export const dynamic = "force-dynamic";

// Server-side route guard for the JEBENA BUNA (hot drink) portal. Same
// live-Staff authority as the Kitchen/Barista layouts — only the role differs.

export default async function JebenaLayout({ children }) {
  const session = await getPortalSession("HOT_DRINK");
  if (!session) return <PinGuard role="HOT_DRINK" next="/jebena" />;
  return children;
}
