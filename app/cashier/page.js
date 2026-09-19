'use client';

import dynamic from 'next/dynamic';

const CashierUI = dynamic(() => import('@/app/components/CashierUI'), {
  ssr: false,
  loading: () => <CashierSkeleton />,
});

export default function CashierPage() {
  return (
    <div className="min-h-screen bg-[var(--c-bg)]">
      <CashierUI />
    </div>
  );
}

function CashierSkeleton() {
  return (
    <div className="min-h-screen bg-[var(--c-bg)] text-[var(--c-text)]">
      <header className="sticky top-0 z-30 bg-[var(--c-header)] dark:bg-transparent border-b border-[var(--c-border-soft)] dark:border-transparent px-4 py-3 shadow-sm dark:shadow-none">
        <div className="flex items-center justify-between">
          <div className="h-6 w-32 animate-pulse rounded bg-black/10 dark:bg-white/10" />
          <div className="h-8 w-20 animate-pulse rounded-xl bg-black/10 dark:bg-white/10" />
        </div>
      </header>
      <main className="p-4 grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5 space-y-3">
          <div className="h-10 animate-pulse rounded-xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)]" />
          <div className="h-24 animate-pulse rounded-2xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)]" />
          <div className="h-24 animate-pulse rounded-2xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)]" />
        </div>
        <div className="lg:col-span-7 space-y-3">
          <div className="h-64 animate-pulse rounded-2xl bg-white dark:bg-[#1C1D24] border border-[var(--c-border-soft)]" />
        </div>
      </main>
    </div>
  );
}
