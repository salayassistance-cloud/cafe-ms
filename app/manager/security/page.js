import ManagerSecurityButton from '@/app/components/ManagerSecurityButton';
import ManagerSidebar from '@/app/components/ManagerSidebar';
import { IconShieldCheck } from '@tabler/icons-react';

export const dynamic = 'force-dynamic';

export default function SecurityPage() {
  return (
    <div className="min-h-screen bg-[#F4F5F9] dark:bg-[#12131A] flex flex-col lg:flex-row">
      <ManagerSidebar />
      <div className="flex-1 min-w-0 overflow-x-hidden p-4 sm:p-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-transparent text-[var(--c-accent)]">
              <IconShieldCheck size={20} className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-xl font-black text-[#1E293B] dark:text-white">Security & PIN</h1>
              <p className="mt-1 text-sm font-medium text-[var(--c-muted)]">Manage PINs and waiter accounts</p>
            </div>
          </div>
          <div className="rounded-2xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)] dark:border-[#2A2B36] p-5 sm:p-6 shadow-sm">
            <ManagerSecurityButton inline />
          </div>
        </div>
      </div>
    </div>
  );
}
