import { redirect } from "next/navigation";

/** Kept as a stable legacy URL; menu management now lives under Settings. */
export default function MenuPage() {
  redirect("/dashboard/settings?tab=menu");
}
