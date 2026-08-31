import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Loading placeholder for public/auth forms that do not use dashboard chrome. */
export function FormLoadingSkeleton({
  rows = 3,
  className,
  label = "در حال بارگذاری فرم",
  showHeading = true,
}: {
  rows?: number;
  className?: string;
  label?: string;
  showHeading?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className={cn("min-w-0 space-y-5", className)}
    >
      <div aria-hidden="true" className="space-y-5">
        {showHeading ? (
          <div className="space-y-2">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
        ) : null}
        <div className="space-y-4">
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
