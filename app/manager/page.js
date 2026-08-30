import { redirect } from "next/navigation";

// /manager opens the executive reports dashboard directly (no auth gate).
export default function ManagerPage() {
  redirect("/manager/reports");
}
