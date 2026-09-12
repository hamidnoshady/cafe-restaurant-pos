import { redirect } from "next/navigation";
import { WEBSITE_OVERVIEW_HREF } from "./website-routes";

/** The bare app prefix — the app's home is its overview. */
export default async function WebsiteIndexPage() {
  redirect(WEBSITE_OVERVIEW_HREF);
}
