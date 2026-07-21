import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ReservationsManager } from "./reservations-manager";

export default async function ReservationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const canBook = ["owner", "manager", "cashier"].includes(session.role);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">رزروها</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          ثبت رزرو با تشخیص تداخل زمانی، و نشاندن مهمانِ رزرو روی میز.
        </p>
      </header>
      <ReservationsManager canBook={canBook} />
    </div>
  );
}
