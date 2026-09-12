import { redirect } from "next/navigation";

/** Kept as a stable legacy URL; team administration now lives under Settings. */
export default function TeamPage() {
  redirect("/settings/team");
}
