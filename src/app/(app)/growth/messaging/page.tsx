import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { MessagingSection } from "../messaging-section";

/** Growth → consent-aware outbound SMS and email campaigns. */
export default async function GrowthMessagingPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager"].includes(session.role)) redirect("/growth/overview");
  return <MessagingSection />;
}
