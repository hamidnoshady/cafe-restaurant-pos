import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { ConsentForm } from "./consent-form";

/**
 * Phase 34 — the OAuth consent screen.
 *
 * It sits outside `/dashboard` on purpose. This is an authorization ceremony,
 * not a settings page: the owner arrives from another application mid-flow, has
 * exactly one decision to make, and leaves again. Wrapping it in the dashboard's
 * sidebar and nav would invite them to wander off, abandoning a flow they cannot
 * restart from inside this app.
 *
 * Middleware already requires a tenant session here (it is not in
 * `PUBLIC_PATHS`) and carries the full URL through `?next=`, so an owner who was
 * signed out lands back on this exact request after logging in.
 *
 * Owner-only, like every other place a long-lived machine credential is issued.
 */
export const dynamic = "force-dynamic";

export default async function McpConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const params = await searchParams;
  const first = (key: string): string =>
    typeof params[key] === "string" ? (params[key] as string) : "";

  const clientId = first("client_id");
  const redirectUri = first("redirect_uri");
  const codeChallenge = first("code_challenge");
  const state = typeof params.state === "string" ? params.state : null;
  const requestedScopes = first("scope").split(/\s+/).filter(Boolean);

  const enabled = await isFeatureEnabled(session.businessId, "api_platform");

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-4">
      <div className="w-full max-w-lg rounded-2xl border border-border/80 bg-white dark:bg-card p-6 shadow-[0_1px_2px_rgb(41_37_36/0.035)] sm:p-8">
        <ConsentForm
          isOwner={session.role === "owner"}
          featureEnabled={enabled}
          clientId={clientId}
          redirectUri={redirectUri}
          codeChallenge={codeChallenge}
          state={state}
          requestedScopes={requestedScopes}
        />
      </div>
    </main>
  );
}
