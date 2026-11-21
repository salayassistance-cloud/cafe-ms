import RoomsUI from "@/app/components/hotel/RoomsUI";
import { requireHotelPageRole } from "@/lib/hotel/auth/serverSession";

// Hotel Room Management route. Like Hotel Reception, authentication is handled
// by the Hotel screen itself through the Hotel-only auth Route Handlers, so
// this route is intentionally outside the POS /manager guard and outside the
// POS sidebar.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Room Management · Bono Hotel",
  description:
    "Hotel room and room-type management: availability overview, operational status changes, and room setup for Managers.",
};

// Room Management uses the established MANAGER Hotel role. A RECEPTIONIST
// session is redirected away before any management UI or data can render.
export default async function HotelRoomsPage() {
  const session = await requireHotelPageRole("MANAGER", "/hotel/reception");
  // Signed out: the shared layout renders the Manager sign-in gate for this
  // route. Render no protected content underneath it.
  if (!session) return null;
  return <RoomsUI />;
}
