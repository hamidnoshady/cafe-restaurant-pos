import { redirect } from "next/navigation";

/** Legacy bookmark: راهنمای بخش‌ها is now the knowledge centre. */
export default function LegacyGuidesPage() {
  redirect("/dashboard/knowledge");
}
