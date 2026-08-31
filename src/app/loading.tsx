import { Skeleton } from "@/components/ui/skeleton";
import { cardClass } from "./dashboard/page-chrome";

/** Root fallback for public routes and for the first render while a realm layout resolves. */
export default function RootLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <section
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="در حال بارگذاری صفحه"
        className={`w-full max-w-md ${cardClass} p-5`}
      >
        <div aria-hidden="true" className="space-y-5">
          <div className="flex items-center gap-3">
            <Skeleton className="size-11 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3 w-56 max-w-full" />
            </div>
          </div>
          <div className="space-y-3 border-t border-stone-100 pt-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        </div>
      </section>
    </main>
  );
}
