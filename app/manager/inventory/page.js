import InventoryUI from '@/app/components/InventoryUI';

export const dynamic = 'force-dynamic';

// Inventory — Manager-protected shell.
// Auth is enforced by the parent app/manager/layout.js (getPortalSession("MANAGER")).
// This page only renders the presentational InventoryUI — no API or DB calls.

export default function InventoryPage() {
  return <InventoryUI />;
}
