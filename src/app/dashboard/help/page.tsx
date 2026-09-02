import { redirect } from "next/navigation";

/** Legacy bookmark: the old گزارش مشکلات/routes page grew into مرکز آموزش. */
export default function LegacyHelpPage() {
  redirect("/dashboard/knowledge");
}
