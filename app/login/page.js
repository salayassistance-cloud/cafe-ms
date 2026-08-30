import PinGuard from "@/app/components/PinGuard";
import Link from "next/link";

export const dynamic = "force-dynamic";

function roleFromNext(next) {
  if (next.startsWith("/waiter")) return "WAITER";
  if (next.startsWith("/kds") || next.startsWith("/kitchen")) return "KITCHEN";
  if (next.startsWith("/barista")) return "BARISTA";
  return "MANAGER";
}

export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const next = String(params?.next || "/waiter");
  const role = roleFromNext(next);

  return (
    <div className="min-h-screen bg-[#F4F5F9] dark:bg-[#12131A]">
      <div className="absolute left-4 top-4 z-[110]">
        <Link
          href="/"
          aria-label="Home"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-[#64748B] dark:text-[#94A3B8] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:text-[#1E293B] dark:hover:text-white   active:shadow-inner"
        >
          ←
        </Link>
      </div>
      <PinGuard role={role} next={next} />
    </div>
  );
}
