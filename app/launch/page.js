"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getSafePwaLaunchRoute } from "@/lib/pwa";

// Static PWA `start_url` target. Replays the last safe per-device route
// (or "/" when none/unsafe). Existing layout guards still enforce
// authentication/authorization normally after the replace.
export default function PwaLaunchPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(getSafePwaLaunchRoute());
  }, [router]);

  return null;
}
