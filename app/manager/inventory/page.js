import InventoryUI from '@/app/components/InventoryUI';
import ManagerSidebar from '@/app/components/ManagerSidebar';
import { getUnifiedMenu } from '@/lib/menuService';

export const dynamic = 'force-dynamic';

// Inventory — Manager-protected shell.
// Auth is enforced by the parent app/manager/layout.js (getPortalSession("MANAGER")).
// Sidebar persists beside full page on desktop; content remains complete.

export default async function InventoryPage() {
  // Manager-only server path. Pass only MenuItem ids and their saved policy to
  // the client — never the full catalog document, and never through the public
  // /api/menu route (which deliberately strips policy metadata).
  let menuPolicies = {};
  try {
    const { items } = await getUnifiedMenu({ includeUnavailable: true });
    menuPolicies = Object.fromEntries(
      (Array.isArray(items) ? items : []).map((item) => [
        String(item._id || item.id),
        item.inventoryPolicy,
      ])
    );
  } catch {
    // An unavailable catalog must not fabricate classifications. The UI shows
    // every item as explicit UNKNOWN (needs review) until the read succeeds.
    menuPolicies = {};
  }

  return (
    <div className="min-h-screen bg-[#F4F5F9] dark:bg-[#12131A] flex flex-col lg:flex-row">
      <ManagerSidebar />
      <div className="flex-1 min-w-0 overflow-x-hidden">
        <InventoryUI menuPolicies={menuPolicies} />
      </div>
    </div>
  );
}
