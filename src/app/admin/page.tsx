import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  hostRoutingEnabled,
  parseHost,
  preferredProto,
  requestHost,
  rootDomain as configuredRootDomain,
  swapHostLabel,
} from "@/lib/host";
import { resolveBusinessByLabel } from "@/lib/host-resolution";
import AdminLoginForm from "./admin-login-form";

// The alias resolution below reads the request's Host header, so this route
// must render per-request rather than be prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * The owner/manager door of a tenant's origin — `biz.{root}/admin`.
 *
 * Before the login split the password form shared `/login` with the staff
 * quick login behind a tab switch; the tenant root is now the staff door
 * only, and admin sign-in lives at this subdirectory of the business's own
 * origin. Same alias rule as src/app/login/page.tsx: a visit to a business's
 * *old* host is forwarded to the current host's `/admin`, because a session
 * minted on a renamed host can never stick.
 */
export default async function AdminLoginPage() {
  if (hostRoutingEnabled()) {
    const rootDomain = configuredRootDomain();
    const headerList = await headers();
    const host = parseHost(requestHost(headerList), rootDomain);

    if (host.kind === "business") {
      const business = await resolveBusinessByLabel(host.label);
      if (business?.viaAlias) {
        const proto = preferredProto(headerList.get("x-forwarded-proto"), "https");
        const forwardedHost = headerList.get("x-forwarded-host") ?? headerList.get("host");
        redirect(`${proto}://${swapHostLabel(forwardedHost, business.subdomain, rootDomain)}/admin`);
      }
    }
  }

  return <AdminLoginForm />;
}
