import { redirect } from "next/navigation";

/**
 * The order detail is a dialog over the queue now (order-detail-modal.tsx),
 * not a screen of its own. This route stays as the address that links made
 * before the change — and links pasted between staff — still resolve to, so
 * it hands off to the queue with that order already open.
 */
export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/dashboard/orders?order=${encodeURIComponent(id)}`);
}
