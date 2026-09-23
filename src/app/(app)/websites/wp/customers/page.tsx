import { requireWpSection } from "../wp-guard";
import { WpCustomersSection } from "../customers-section";

/** مشتریان فروشگاه، متصل به پروندهٔ مشتریان CRM. */
export default async function WpCustomersPage() {
  await requireWpSection("customers");
  return <WpCustomersSection />;
}
