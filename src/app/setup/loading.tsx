import { Skeleton } from "@/components/ui/skeleton";

/** The setup layout supplies the card; this mirrors one wizard step inside it. */
export default function SetupLoading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="در حال بارگذاری مرحله راه‌اندازی">
      <div aria-hidden="true" className="space-y-6">
        <header className="space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-[28rem] max-w-full" />
        </header>
        <div className="space-y-4">
          {[0, 1, 2].map((row) => (
            <div key={row} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
          ))}
        </div>
        <div className="flex justify-between border-t border-border/80 pt-4">
          <Skeleton className="h-10 w-24 rounded-lg" />
          <Skeleton className="h-10 w-28 rounded-lg" />
        </div>
      </div>
    </div>
  );
}
