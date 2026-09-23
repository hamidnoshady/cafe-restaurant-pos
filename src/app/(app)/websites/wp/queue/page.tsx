import { requireWpSection } from "../wp-guard";
import { WpQueueSection } from "../queue-section";

/** صف عملیات خروجی و رویدادهای ورودی ناموفق. */
export default async function WpQueuePage() {
  await requireWpSection("queue");
  return <WpQueueSection />;
}
