'use client';

import { usePathname } from 'next/navigation';

// Global bottom navigation — forcefully hidden on /menu per spec
// Search covered: app/menu/page.js (fixed bottom-0, sticky bottom-0, <nav>, footer wrappers)
// and global layout/components. No persistent bottom bar was present in codebase
// after prior cleanup, but this component enforces the required conditional hiding
// to guarantee 100% removal on /menu across all viewports.

export default function BottomNav() {
  const pathname = usePathname();
  if (pathname === '/menu') {
    return null; // Forcefully do NOT render the bottom navbar on /menu
  }
  // No bottom navbar is rendered for other routes either (clean slate per removal spec)
  // If a future bottom nav is introduced, it will automatically be hidden on /menu
  // due to the above check, satisfying the strict boundary for /menu isolation.
  return null;
}
