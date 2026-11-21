import ReceptionUI from "@/app/components/hotel/ReceptionUI";
import { requireHotelPageRole } from "@/lib/hotel/auth/serverSession";

// Hotel Reception route. Authentication is handled by the Hotel screen itself
// through the Hotel-only auth Route Handlers, so this route is intentionally
// outside the POS /manager guard and outside the POS sidebar.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reception · Bono Hotel",
  description:
    "Hotel front-desk reception for guests, reservations, check-in, check-out, and recorded payments.",
};

// Reception is a distinct Hotel destination. Only a live RECEPTIONIST session
// may render it; a Room Management/Room Reports (MANAGER) session is redirected
// away server-side. The /hotel layout still owns the shared PIN gate.
export default async function HotelReceptionPage() {
  const session = await requireHotelPageRole("RECEPTIONIST", "/hotel/rooms");
  // Signed out: the shared layout renders the Reception sign-in gate for this
  // route. Render no protected content underneath it.
  if (!session) return null;
  return <ReceptionUI />;
}
