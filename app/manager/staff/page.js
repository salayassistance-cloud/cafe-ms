import StaffManagement from "@/app/components/StaffManagement";
import ManagerSidebar from "@/app/components/ManagerSidebar";

export const dynamic = "force-dynamic";

export default function StaffPage() {
  return (
    <div className="min-h-screen bg-[#F4F5F9] dark:bg-[#12131A] flex flex-col lg:flex-row">
      <ManagerSidebar />
      <div className="flex-1 min-w-0 overflow-x-hidden">
        <StaffManagement />
      </div>
    </div>
  );
}
