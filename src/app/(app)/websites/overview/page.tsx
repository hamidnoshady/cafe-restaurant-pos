import { WebsiteAppHome } from "../website-home";

/**
 * `/websites/overview` — «مدیریت وب‌سایت»'s home.
 *
 * A real route segment beside `cms/` and `wp/`, so the app's front page has the
 * same shape of address as every other app's (`/crm/overview`,
 * `/growth/overview`) and is never produced by rewriting `/dashboard/website`.
 */
export default async function WebsiteOverviewPage() {
  return <WebsiteAppHome />;
}
