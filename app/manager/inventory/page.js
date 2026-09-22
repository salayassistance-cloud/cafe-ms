import InventoryUI from '@/app/components/InventoryUI';
import ManagerSidebar from '@/app/components/ManagerSidebar';

export const dynamic = 'force-dynamic';

// Inventory — Manager-protected shell.
// Auth is enforced by the parent app/manager/layout.js (getPortalSession("MANAGER")).
// Sidebar persists beside full page on desktop; content remains complete.

export default function InventoryPage() {
  return (
    <div className="min-h-screen bg-[#F4F5F9] dark:bg-[#12131A] flex flex-col lg:flex-row">
      <ManagerSidebar />
      <div className="flex-1 min-w-0 overflow-x-hidden">
        <InventoryUI />
      </div>
    </div>
  );
}
