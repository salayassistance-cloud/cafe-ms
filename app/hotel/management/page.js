import HotelStaffManagementUI from "@/app/components/hotel/HotelStaffManagementUI";
import { requireHotelPageRole } from "@/lib/hotel/auth/serverSession";

// Hotel Staff Management — a Manager-only destination. It sits alongside the
// existing Reception, Room Management and Reports pages and reuses the shared
// Hotel layout/session gate. No POS manager UI or guard is involved.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Staff Management · Bono Hotel",
  description:
    "Manager-controlled Receptionist identities, individual PINs and account status.",
};

export default async function HotelManagementPage() {
  const session = await requireHotelPageRole("MANAGER", "/hotel/reception");
  // Signed out: the shared layout renders the Manager sign-in gate for this
  // route. Render no protected content underneath it.
  if (!session) return null;
  return <HotelStaffManagementUI />;
}
