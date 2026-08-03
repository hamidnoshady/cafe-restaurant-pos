import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { JewelryManager } from "./jewelry-manager";

export default async function JewelryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "jewelry");

  return (
    <div className="mx-auto w-full max-w-[1600px]">
      <header className="mb-5 border-b border-stone-200/80 pb-5 sm:mb-6 sm:pb-6">
        <h1 className="text-2xl font-bold tracking-tight text-stone-950 sm:text-[1.7rem]">
          طلا و جواهر
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          کالاهای وزنی، نرخ روز طلا، امانت‌گذاران و فروش قطعات طلا.
        </p>
      </header>
      <JewelryManager />
    </div>
  );
}
