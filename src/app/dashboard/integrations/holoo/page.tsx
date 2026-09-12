import { redirect } from "next/navigation";

/** Legacy Holoo wizard URL; technical connection workflows now live in Connections. */
export default async function LegacyHolooMigrationPage({
  searchParams,
}: {
  searchParams: Promise<{ connectionId?: string }>;
}) {
  const { connectionId } = await searchParams;
  redirect(
    connectionId
      ? `/settings/connections/holoo?connectionId=${encodeURIComponent(connectionId)}`
      : "/settings/connections/holoo",
  );
}
