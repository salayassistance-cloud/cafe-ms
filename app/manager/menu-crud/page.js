import MenuCrudClient from "./MenuCrudClient";
import { getUnifiedMenu } from "@/lib/menuService";

export const dynamic = "force-dynamic";

// Canonical menu fetch — delegates to lib/menuService (single alias resolver).
// This page previously duplicated serialization; now it reuses the same service
// as GET /api/menu so /manager/menu-crud and /waiter see identical catalogs.
async function getData() {
  try {
    const { categories, items } = await getUnifiedMenu({ includeUnavailable: true });
    return {
      categories,
      items,
      source: "mongodb:hotel_management",
    };
  } catch (e) {
    return { categories: [], items: [], source: "mongodb:empty" };
  }
}

export default async function MenuCrudPage() {
  const { categories, items, source } = await getData();
  return (
    <div className="min-h-screen bg-[#F4F5F9] dark:bg-[#12131A] text-[#1E293B] dark:text-white">
      <MenuCrudClient initialCategories={categories} initialItems={items} source={source} />
    </div>
  );
}
