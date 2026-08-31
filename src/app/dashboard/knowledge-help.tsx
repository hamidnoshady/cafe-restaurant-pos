"use client";

/**
 * «آموزش» — the knowledge-base icon that sits in a dashboard page's header.
 *
 * The super-admin stores one learning page (a URL) per section in the console
 * (`/platform/knowledge`); this button asks `GET /api/knowledge` for the
 * section the page belongs to and opens that URL in a modal, so a member can
 * learn the screen they are standing on without leaving it. Pages pass their
 * own `section` key; a shared shell that spans several sections (the Growth
 * app's header) omits it and the current route resolves the section instead.
 *
 * When no page is stored yet — or the network fails — the modal says so
 * plainly; the icon never breaks the page it is mounted in. The iframe's host
 * may refuse to be embedded; the «باز کردن در تب جدید» link is always there
 * as the fallback that never can fail.
 */
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ExternalLinkIcon, GraduationCapIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { knowledgeSection, sectionForPathname } from "@/lib/knowledge-base";
import { api } from "./ui";

interface KnowledgeEntry {
  section: string;
  label: string;
  url: string;
}

type EntryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; entry: KnowledgeEntry | null }
  | { status: "error" };

export function KnowledgeHelpButton({ section }: { section?: string }) {
  const pathname = usePathname();
  const resolved = section
    ? knowledgeSection(section)
    : sectionForPathname(pathname ?? "");
  const resolvedKey = resolved?.key;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<EntryState>({ status: "idle" });
  const [frameLoaded, setFrameLoaded] = useState(false);

  const fetchEntry = useCallback(async () => {
    if (!resolvedKey) return;
    setState({ status: "loading" });
    try {
      const { ok, data } = await api<{ entry: KnowledgeEntry | null }>(
        `/api/knowledge?section=${encodeURIComponent(resolvedKey)}`,
      );
      if (!ok) {
        setState({ status: "error" });
        return;
      }
      setState({ status: "ready", entry: data.entry ?? null });
    } catch {
      setState({ status: "error" });
    }
  }, [resolvedKey]);

  useEffect(() => {
    setState({ status: "idle" });
    setFrameLoaded(false);
  }, [resolvedKey]);

  if (!resolved) return null;

  const label = resolved.label;

  function openModal() {
    setFrameLoaded(false);
    setOpen(true);
    if (state.status === "idle" || state.status === "error") void fetchEntry();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        aria-label={`آموزش ${label}`}
        title={`آموزش ${label}`}
        onClick={openModal}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <GraduationCapIcon className="size-5 shrink-0" aria-hidden="true" />
      </button>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>آموزش: {label}</DialogTitle>
          <DialogDescription>
            راهنمای این بخش — می‌توانید آن را در تب جدید هم باز کنید.
          </DialogDescription>
        </DialogHeader>

        {state.status === "loading" ? (
          <Skeleton className="h-[65svh] min-h-[320px] rounded-xl" />
        ) : state.status === "error" ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-4 text-center">
            <p className="text-sm text-muted-foreground">
              صفحهٔ آموزشی بارگذاری نشد؛ دوباره تلاش کنید.
            </p>
            <button
              type="button"
              onClick={() => void fetchEntry()}
              className="rounded-lg border border-border/80 px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
            >
              تلاش دوباره
            </button>
          </div>
        ) : state.status === "ready" && state.entry ? (
          <div className="relative h-[65svh] min-h-[320px]">
            {!frameLoaded ? (
              <div
                role="status"
                aria-live="polite"
                aria-busy="true"
                aria-label="در حال بارگذاری صفحه آموزشی"
                className="absolute inset-0 z-10"
              >
                <Skeleton aria-hidden="true" className="h-full w-full rounded-xl" />
              </div>
            ) : null}
            <iframe
              src={state.entry.url}
              title={`آموزش ${label}`}
              onLoad={() => setFrameLoaded(true)}
              className={`h-full w-full rounded-xl border border-border/80 bg-card transition-opacity motion-reduce:transition-none ${frameLoaded ? "opacity-100" : "opacity-0"}`}
            />
          </div>
        ) : (
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 text-center">
            <GraduationCapIcon className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground/80">
              هنوز صفحهٔ آموزشی برای این بخش ثبت نشده است.
            </p>
            <p className="text-xs text-muted-foreground">
              از تیم پشتیبانی بخواهید راهنمای این بخش را در پایگاه دانش ثبت کند.
            </p>
          </div>
        )}

        {state.status === "ready" && state.entry ? (
          <a
            href={state.entry.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            dir="ltr"
          >
            <span className="truncate">{state.entry.url}</span>
            <ExternalLinkIcon className="size-4 shrink-0" aria-hidden="true" />
            <span dir="rtl">باز کردن در تب جدید</span>
          </a>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
