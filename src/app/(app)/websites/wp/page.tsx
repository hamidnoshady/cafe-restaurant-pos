import { requireWpSection } from "./wp-guard";
import { WpOverviewSection } from "./overview-section";

/** The WordPress & WooCommerce Manager — میز کار. */
export default async function WpManagerPage() {
  await requireWpSection("overview");

  return <WpOverviewSection />;
}
