import { redirect } from "next/navigation";
import { growthSectionHref } from "./growth-routes";

/** The bare app prefix — the app's home is its overview. */
export default async function GrowthIndexPage() {
  redirect(growthSectionHref("overview"));
}
