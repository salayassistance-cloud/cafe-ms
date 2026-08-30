import { SITE_CONFIG } from "@/lib/constants";

export default function manifest() {
  return {
    name: SITE_CONFIG.name,
    short_name: SITE_CONFIG.shortName,
    description:
      "የአስተናጋጅ ትዕዛዝ ማስገቢያ — Waiter order entry for Hotel Management System",
    id: "/waiter",
    start_url: "/waiter",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F4F5F9",
    theme_color: "#FFDC00",
    categories: ["food", "business"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
