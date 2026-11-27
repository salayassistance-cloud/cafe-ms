import { getPortalSession } from "@/lib/authServer";
import PinGuard from "@/app/components/PinGuard";
import RoomsUI from "@/app/components/hotel/RoomsUI";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Room Management · Bono Hotel",
  description:
    "Hotel room and room-type management: availability overview, operational status changes, and room setup.",
};

export default async function HotelRoomsPage() {
  const session = await getPortalSession("MANAGER");
  if (!session) return <PinGuard role="MANAGER" next="/hotel/rooms" />;
  return <RoomsUI />;
}
