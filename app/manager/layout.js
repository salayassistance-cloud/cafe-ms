import { getPortalSession } from "@/lib/authServer";
import PinGuard from "@/app/components/PinGuard";

export const dynamic = "force-dynamic";

// Server-side route guard for the Manager dashboard (covers /manager and
// /manager/reports). On success the guard lands the user on the reports screen.

export default async function ManagerLayout({ children }) {
  const session = await getPortalSession("MANAGER");
  if (!session) return <PinGuard role="MANAGER" next="/manager/reports" />;
  return (
    <div className="min-h-screen bg-[#F4F5F9] dark:bg-[#12131A]">
      {children}
    </div>
  );
}
