"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EyeIcon, LogOutIcon, ShieldAlertIcon, WrenchIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatPersianNumber } from "@/lib/digits";
import {
  SUPPORT_SESSION_EXIT_PATH,
  supportSessionRemainingMs,
  type SupportSessionEndResponse,
} from "@/lib/support-session";
import { api, ErrorBox } from "./ui";

const MODE = {
  read_only: { label: "فقط خواندنی", Icon: EyeIcon },
  controlled: { label: "دسترسی محدود فنی", Icon: WrenchIcon },
  full: { label: "دسترسی تغییر", Icon: ShieldAlertIcon },
  emergency: { label: "دسترسی اضطراری", Icon: ShieldAlertIcon },
} as const;

const END_FAILED = "پایان نشست پشتیبانی انجام نشد. دوباره تلاش کنید.";
const CHANNEL = "support-session";

/** Indirection so tests can observe the navigation jsdom cannot perform. */
export const supportSessionNavigation = {
  leave(url: string) {
    window.location.replace(url);
  },
};

type EndResult = { ok: true; redirectTo: string } | { ok: false };

/**
 * End this browser's support session on the server and report where to go.
 * The server clears the tenant cookie and answers idempotently, so an already
 * ended/expired session still comes back `ok` with the console address.
 */
export async function endSupportSession(grantId: string): Promise<EndResult> {
  const { ok, data } = await api<Partial<SupportSessionEndResponse> & { error?: string }>(
    `${SUPPORT_SESSION_EXIT_PATH}?grantId=${encodeURIComponent(grantId)}`,
    { method: "DELETE" },
  );
  if (ok && typeof data.redirectTo === "string") return { ok: true, redirectTo: data.redirectTo };
  return { ok: false };
}

function announceEnded(grantId: string, redirectTo: string) {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ type: "ended", grantId, redirectTo });
  channel.close();
}

function remainingLabel(ms: number): string {
  if (ms <= 0) return "نشست منقضی شده است";
  if (ms < 60_000) return "کمتر از یک دقیقه باقی‌مانده";
  return `${formatPersianNumber(Math.ceil(ms / 60_000))} دقیقه باقی‌مانده`;
}

export function SupportSessionBanner({ session }: { session: {
  grantId: string;
  businessName: string;
  operatorName: string;
  mode: keyof typeof MODE;
  expiresAt: string;
  /** The server's clock when the page rendered; the countdown runs on it, not the browser's. */
  serverNow: string;
} }) {
  const [renderedAt] = useState(() => Date.now());
  const [now, setNow] = useState(renderedAt);
  const [confirming, setConfirming] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endingRef = useRef(false);
  const meta = MODE[session.mode];
  const remaining = supportSessionRemainingMs(session.expiresAt, session.serverNow, renderedAt, now);

  const end = useCallback(async (reason: "manual" | "expired") => {
    if (endingRef.current) return;
    endingRef.current = true;
    setEnding(true);
    setError(null);
    const result = await endSupportSession(session.grantId);
    if (result.ok) {
      announceEnded(session.grantId, result.redirectTo);
      supportSessionNavigation.leave(result.redirectTo);
      return;
    }
    endingRef.current = false;
    setEnding(false);
    if (reason === "manual") setError(END_FAILED);
    toast.error(END_FAILED);
  }, [session.grantId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // At the server's expiry instant, leave through the same close the button
  // uses: the server stamps the grant expired, clears the cookie, and answers
  // with the console address.
  useEffect(() => {
    const left = supportSessionRemainingMs(session.expiresAt, session.serverNow, renderedAt, Date.now());
    const timer = window.setTimeout(() => {
      setNow(Date.now());
      void end("expired");
    }, left);
    return () => window.clearTimeout(timer);
  }, [end, renderedAt, session.expiresAt, session.serverNow]);

  // Another tab of this origin ended the session: the cookie is already gone,
  // so this tab has no access left either — follow it out.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<{ type?: string; grantId?: string; redirectTo?: string }>) => {
      if (endingRef.current) return;
      if (event.data?.type === "ended" && event.data.grantId === session.grantId && event.data.redirectTo) {
        endingRef.current = true;
        supportSessionNavigation.leave(event.data.redirectTo);
      }
    };
    return () => channel.close();
  }, [session.grantId]);

  // Back/forward cache restores a page without asking the server; ask it.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  return (
    <aside
      aria-label="نشست پشتیبانی"
      className="border-b border-amber-500/30 bg-amber-50 px-3 py-2 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <meta.Icon className="size-4 shrink-0" aria-hidden="true" />
          <strong className="truncate">نشست پشتیبانی · {meta.label}</strong>
          <span className="hidden truncate text-current/75 sm:inline">اپراتور: {session.operatorName} · مشاهدهٔ {session.businessName}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span role="timer" aria-live="polite">{remainingLabel(remaining)}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setError(null); setConfirming(true); }}
            disabled={ending}
            aria-busy={ending}
          >
            <LogOutIcon aria-hidden="true" />
            {ending ? "در حال پایان نشست…" : "پایان نشست"}
          </Button>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={(open) => { if (!ending) setConfirming(open); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>پایان نشست پشتیبانی</DialogTitle>
            <DialogDescription>
              آیا می‌خواهید دسترسی پشتیبانی به {session.businessName} را پایان دهید؟ پس از پایان، به کنسول پلتفرم بازمی‌گردید.
            </DialogDescription>
          </DialogHeader>
          <ErrorBox>{error}</ErrorBox>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={ending}>انصراف</Button>
            <Button variant="destructive" onClick={() => void end("manual")} disabled={ending} aria-busy={ending}>
              {ending ? "در حال پایان نشست…" : "پایان نشست"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

/**
 * What a page renders instead of redirecting to /login when the browser still
 * carries a support cookie whose grant is over — revoked from the console,
 * ended in another tab, or expired while the tab was closed. It runs the
 * same close the banner does (idempotent on the server, and it clears the
 * cookie) and sends the operator back to the console.
 */
export function SupportSessionEnded({ grantId }: { grantId: string }) {
  const [failed, setFailed] = useState(false);
  const leave = useCallback(async () => {
    setFailed(false);
    const result = await endSupportSession(grantId);
    if (result.ok) supportSessionNavigation.leave(result.redirectTo);
    else setFailed(true);
  }, [grantId]);

  useEffect(() => { void leave(); }, [leave]);

  return (
    <main className="flex min-h-dvh items-center justify-center p-6" aria-busy={!failed}>
      <div className="w-full max-w-sm space-y-3 text-center">
        <h1 className="text-base font-semibold">نشست پشتیبانی پایان یافته است</h1>
        {failed ? (
          <>
            <ErrorBox>{END_FAILED}</ErrorBox>
            <Button onClick={() => void leave()}>تلاش دوباره</Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">در حال بازگشت به کنسول پلتفرم…</p>
        )}
      </div>
    </main>
  );
}
