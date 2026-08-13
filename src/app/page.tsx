import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import {
  hostRoutingEnabled,
  parseHost,
  preferredProto,
  requestHost,
  rootDomain as configuredRootDomain,
  swapHostLabel,
} from "@/lib/host";
import { resolveBusinessByLabel } from "@/lib/host-resolution";
import { hasAnyUser, isSetupComplete } from "@/lib/setup-state";
import { BusinessDirectory } from "./business-directory";

/**
 * Shown when `ROOT_DOMAIN` is set but the request's hostname is not under it.
 *
 * Almost always an operator-facing message rather than a customer-facing one,
 * so it names the two things that actually cause it: a hostname that was never
 * pointed at this deployment, and a proxy that rewrites `Host` (the case
 * `TRUST_FORWARDED_HOST` exists for).
 */
function UnresolvableHost() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-card p-8 text-center shadow-sm">
        <h1 className="mb-2 text-lg font-bold">این نشانی به کسب‌وکاری تعلق ندارد</h1>
        <p className="text-sm text-muted-foreground">
          نشانی اینترنتی کسب‌وکار خود را وارد کنید یا با پشتیبانی تماس بگیرید.
        </p>
        <p className="mt-6 text-start text-xs text-muted-foreground" dir="ltr">
          This hostname is not under ROOT_DOMAIN. If a proxy or platform rewrites the Host header,
          set TRUST_FORWARDED_HOST=on; <code>/api/host/resolve?debug=1</code> shows what the app
          sees.
        </p>
      </div>
    </main>
  );
}

export default async function Home() {
  // Phase 23 — this page is the only place that can do host resolution for a
  // browser landing on `/`: middleware runs on Edge and cannot reach Postgres,
  // so "which business is this host, and is it an old name?" has to be
  // answered here.
  const rootDomain = configuredRootDomain();
  if (hostRoutingEnabled()) {
    const headerList = await headers();
    const host = parseHost(requestHost(headerList), rootDomain);

    // The apex has no tenant to show. It is a signpost to the business hosts.
    if (host.kind === "apex") return <BusinessDirectory />;

    // A hostname this deployment cannot name a tenant for. Every redirect
    // cycle passes through `/`, so this is where one has to stop: continuing
    // on to `/dashboard` sends the request back into middleware, which bounces
    // it to the host resolver, which bounces it back here — forever, and with
    // a managed platform's health probe caught in it, that loop takes the
    // whole deployment down with a 502. Stopping costs a legitimate visitor
    // (someone reaching the app by IP, or by the platform's own default
    // domain) nothing but an explanation.
    if (host.kind === "unknown") return <UnresolvableHost />;

    if (host.kind === "business") {
      const business = await resolveBusinessByLabel(host.label);
      // Arrived on a host the business used to have: send them to the current
      // one so bookmarks made before a rename still work. The scheme and port
      // come from the request rather than being assumed — behind a proxy the
      // app's own view of them is the internal one.
      if (business?.viaAlias) {
        const proto = preferredProto(headerList.get("x-forwarded-proto"), "https");
        const forwardedHost = headerList.get("x-forwarded-host") ?? headerList.get("host");
        redirect(`${proto}://${swapHostLabel(forwardedHost, business.subdomain, rootDomain)}/`);
      }
    }
  }

  const session = await getSession();
  if (!session) {
    // Empty install → first-run wizard; otherwise normal login.
    redirect((await hasAnyUser()) ? "/login" : "/welcome");
  }
  // Owner/Manager land in the wizard until setup is finished.
  if (
    (session.role === "owner" || session.role === "manager") &&
    !(await isSetupComplete(session.businessId))
  ) {
    redirect("/setup");
  }
  // The dashboard has one address. A business is named by its origin, never by
  // a path prefix: `/{slug}/dashboard` is the retired form, still redirected
  // for old bookmarks (see handleLegacyPathRedirect in src/middleware.ts) but
  // no longer generated anywhere.
  redirect("/dashboard");
}
