import RoomReportsUI from "@/app/components/hotel/RoomReportsUI";
import { requireHotelPageRole } from "@/lib/hotel/auth/serverSession";

// Hotel Room Reports route. Like Reception and Room Management, authentication
// is handled by the Hotel screen itself through the Hotel-only auth Route
// Handlers, so this route is intentionally outside the POS /manager guard and
// outside the POS sidebar.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Hotel Reports",
  description:
    "Room performance, payments, and current room status for hotel managers.",
};

// Room Reports shares the MANAGER role with Room Management. The same PIN and
// session are reused; a RECEPTIONIST session is rejected on the server.
export default async function HotelRoomReportsPage() {
  const session = await requireHotelPageRole("MANAGER", "/hotel/reception");
  // Signed out: the shared layout renders the Manager sign-in gate for this
  // route. Render no protected content underneath it.
  if (!session) return null;
  return <RoomReportsUI />;
}
