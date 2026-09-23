import { requireWpSection } from "../wp-guard";
import { TaxonomiesSectionHost } from "../store-section-host";

/** درخت دسته‌بندی، برچسب و ویژگی‌های فروشگاه. */
export default async function WpTaxonomiesPage() {
  await requireWpSection("taxonomies");
  return <TaxonomiesSectionHost />;
}
