import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { FloorPlan } from "./floor-plan";

export default async function FloorPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const canEdit = session.role === "owner" || session.role === "manager";

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">میزها و پلان سالن</h1>
        <p className="mt-1 text-sm text-stone-500">
          نقشهٔ سالن، وضعیت میزها، نشاندن مهمان و مدیریت نشست‌ها.
        </p>
      </header>
      <FloorPlan canEdit={canEdit} />
    </div>
  );
}
