import { redirect } from "next/navigation";

// /kitchen is an alias for the KDS board (the canonical route is /kds).
export default function KitchenPage() {
  redirect("/kds");
}
