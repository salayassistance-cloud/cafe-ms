import { getPortalSession } from "@/lib/authServer";
import PinGuard from "@/app/components/PinGuard";
import RoomReportsUI from "@/app/components/hotel/RoomReportsUI";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Hotel Reports",
  description:
    "Room performance, payments, and current room status for hotel operations.",
};

export default async function HotelRoomReportsPage() {
  const session = await getPortalSession("MANAGER");
  if (!session) return <PinGuard role="MANAGER" next="/hotel/reports" />;
  return <RoomReportsUI />;
}
