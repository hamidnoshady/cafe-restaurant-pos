import { redirect } from "next/navigation";

/** Security remains a settings tab; this directory owns only its support-access child. */
export default function SecurityIndexPage() {
  redirect("/settings/security-center");
}
