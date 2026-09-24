import { requireWpSection } from "../wp-guard";
import { WpContentSection } from "../content-section";

/** نوشته‌ها و برگه‌های وردپرس: مشاهده، ویرایش و ایجاد. */
export default async function WpContentPage() {
  await requireWpSection("content");
  return <WpContentSection />;
}
