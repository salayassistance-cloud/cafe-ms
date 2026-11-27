// Hotel layout gate: permits authenticated POS MANAGER or RECEPTION sessions.
// Manager-only sub-pages enforce getPortalSession("MANAGER") at page level.
import { cookies } from "next/headers";
import { getLiveSessionFromCookies } from "@/lib/serverAuth";
import PinGuard from "@/app/components/PinGuard";

export const dynamic = "force-dynamic";

export default async function HotelLayout({ children }) {
  const store = await cookies();
  const session = await getLiveSessionFromCookies(store, [
    "MANAGER",
    "RECEPTION",
  ]);
  if (!session) return <PinGuard role="RECEPTION" next="/hotel/reception" />;
  return <>{children}</>;
}
