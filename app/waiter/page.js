'use client';

import dynamic from 'next/dynamic';

const WaiterUI = dynamic(() => import('@/app/components/WaiterUI'), {
  ssr: false,
  loading: () => <WaiterSkeleton />,
});

export default function WaiterPage() {
  return (
    <div className="w-full md:max-w-[420px] lg:max-w-[440px] mx-auto h-[100dvh] max-h-[100dvh] md:h-[100vh] md:max-h-[100vh] min-h-[100dvh] overflow-hidden bg-[#F4F5F9] dark:bg-[#12131A] flex flex-col md:shadow-[0_4px_24px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.05)] md:rounded-[10px] relative">
      <WaiterUI />
    </div>
  );
}

function WaiterSkeleton() {
  return (
    <div className="flex flex-1 flex-col bg-[#F4F5F9] dark:bg-[#12131A] text-[#1E293B] dark:text-white min-h-screen">
      <header className="sticky top-0 z-30 bg-[#FFDC00] dark:bg-transparent border-b border-[#E2E8F0]/60 dark:border-transparent dark:border-none pt-[env(safe-area-inset-top)] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-none">
        <div className="flex items-center justify-between px-4 pb-2 pt-3">
          <div className="h-11 w-32 animate-pulse rounded-2xl bg-white/60 dark:bg-[#2A2B36]" />
          <div className="h-8 w-20 animate-pulse rounded-xl bg-[#FFD600]/20 dark:bg-[#FF5E00]/20" />
        </div>
        <div className="flex gap-2 overflow-x-auto px-4 pb-3 pt-1">
          <div className="h-7 w-16 animate-pulse rounded-full bg-white dark:bg-[#2A2B36]" />
          <div className="h-7 w-20 animate-pulse rounded-full bg-white/80 dark:bg-[#2A2B36]/80" />
          <div className="h-7 w-20 animate-pulse rounded-full bg-white/60 dark:bg-[#2A2B36]/60" />
        </div>
      </header>
      <main className="p-4 grid grid-cols-2 gap-3">
        <div className="h-40 animate-pulse rounded-3xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]" />
        <div className="h-40 animate-pulse rounded-3xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]" />
      </main>
    </div>
  );
}
