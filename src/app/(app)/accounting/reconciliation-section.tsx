"use client";

/**
 * «تطبیق بانکی و صندوق» — matching an account's book postings against the
 * statement the bank (or the till count) says is true.
 *
 * The screen answers one question in one place: *does what we recorded agree
 * with what the account actually holds, and if not, which items are missing?*
 * Everything here follows from that.
 *
 * What the redesign fixed, each of which was a real failure of the old screen:
 *
 *  - **The account picker was a three-column grid that never wrapped**
 *    (`grid-cols-3` with `min-w-full` on a phone): three Persian labels in
 *    three ~100px columns, each clipped mid-word. It is a wrapping row of
 *    pills now, each carrying its own ledger code instead of hiding it in a
 *    `title=` that no touch device will ever show.
 *  - **The date and the balance said what they were, never what they meant.**
 *    The form now shows the account's opening balance, its last statement date
 *    and how many items are waiting — so the two fields are filled in with
 *    knowledge rather than guessed at.
 *  - **The line list had no search, no filter and no totals.** A busy صندوق
 *    carries a year of order postings; the only tool for finding the one
 *    ۲٬۴۰۰٬۰۰۰ item on a statement was the scrollbar.
 *  - **Ticking a line re-fetched the entire reconciliation** and rebuilt the
 *    list from scratch, so every click cost a round trip and the checkbox lagged
 *    behind the finger. Toggling is optimistic now and reconciles against the
 *    server's answer; «انتخاب همه» is one request, not three hundred.
 *  - **The mobile card wrapped the whole row in a `<label>`** containing the
 *    checkbox, so tapping anywhere — including the amounts you were reading —
 *    silently toggled the line.
 *  - **«تکمیل و قفل کردن» was disabled with no explanation.** It says what is
 *    still out by how much, and the difference card says which direction.
 *  - **A reconciliation started with a wrong date or balance was permanent.**
 *    It can never balance, a completed one is immutable and only one may be in
 *    progress per account — so the account's screen was stuck for good. There
 *    is a «لغو تطبیق» now, behind a confirmation.
 *  - **The history was two facts in a flat list.** It carries status, item
 *    count and completion date, and it is a real table on a desktop.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  BanknoteIcon,
  CheckCircle2Icon,
  CreditCardIcon,
  LandmarkIcon,
  ListChecksIcon,
  RefreshCwIcon,
  SearchIcon,
  TrashIcon,
  WalletIcon,
  XIcon,
} from "lucide-react";

import { cardClass, EmptyState, LoadingSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, errorMessage, inputClass } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, isoDateInTimeZone } from "@/lib/jalali";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import {
  filterReconciliationLines,
  reconciliationBalances,
  RECONCILABLE_ACCOUNT_META,
  RECONCILABLE_ACCOUNTS,
  type ReconcilableAccount,
  type ReconciliationLine,
  type ReconciliationLineFilter,
} from "@/lib/reconciliation";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

interface ReconciliationSummary {
  id: string;
  accountCode: ReconcilableAccount;
  accountLabel: string;
  statementDate: string;
  statementBalance: number;
  status: "in_progress" | "completed";
  completedAt: string | null;
  createdAt: string | null;
  clearedCount: number;
}

interface ReconciliationDetail extends ReconciliationSummary {
  openingBalance: number;
  clearedTotal: number;
  unclearedCount: number;
  unclearedTotal: number;
  debitTotal: number;
  creditTotal: number;
  computedBalance: number;
  difference: number;
  lines: ReconciliationLine[];
}

interface AccountOverview {
  accountCode: ReconcilableAccount;
  accountLabel: string;
  accountName: string;
  accountLedgerCode: string;
  openingBalance: number;
  lastStatementDate: string | null;
  ledgerBalance: number;
  unreconciledCount: number;
  unreconciledTotal: number;
}

const ACCOUNT_ICONS: Record<ReconcilableAccount, typeof WalletIcon> = {
  cash: WalletIcon,
  bank: LandmarkIcon,
  bankClearing: CreditCardIcon,
};

const LINE_FILTERS: { key: ReconciliationLineFilter; label: string }[] = [
  { key: "all", label: "همه" },
  { key: "uncleared", label: "تطبیق‌نشده" },
  { key: "cleared", label: "تطبیق‌شده" },
];

/** How many rows the list shows before the reader asks for more. */
const PAGE_SIZE = 50;

/**
 * Today as the reader's own calendar names it. `new Date().toISOString()` is
 * the date in *UTC*, which is still yesterday for the first three and a half
 * hours of every Tehran day — so a statement dated today was rejected as being
 * in the future for anyone opening this before 03:30.
 */
function todayIso(): string {
  return isoDateInTimeZone(new Date()) ?? new Date().toISOString().slice(0, 10);
}

function jalali(iso: string | null | undefined): string {
  if (!iso) return "—";
  return toPersianDigits(formatJalali(iso.slice(0, 10)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function ReconciliationSection({
  busy,
  run,
}: {
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean>;
}) {
  const money = useMoney();
  const [accountCode, setAccountCode] = useState<ReconcilableAccount>("cash");
  const [history, setHistory] = useState<ReconciliationSummary[] | null>(null);
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [detail, setDetail] = useState<ReconciliationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [statementDate, setStatementDate] = useState("");
  const [statementBalance, setStatementBalance] = useState("");
  const [formError, setFormError] = useState("");

  const [query, setQuery] = useState("");
  const [lineFilter, setLineFilter] = useState<ReconciliationLineFilter>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [pendingLines, setPendingLines] = useState<ReadonlySet<string>>(new Set());
  const [confirmCancel, setConfirmCancel] = useState(false);

  /*
   * A request started for account A must never land on account B's state. The
   * old screen fired one fetch per account click and applied whichever came
   * back last, so clicking «بانک» then «صندوق» on a slow link could leave the
   * صندوق button selected with بانک's reconciliation under it — the
   * accountant ticking off the wrong account's lines.
   */
  const requestRef = useRef(0);

  const loadHistory = useCallback(() => {
    const token = ++requestRef.current;
    setHistory(null);
    setOverview(null);
    setDetail(null);
    setLoadFailed(false);
    api<{ reconciliations: ReconciliationSummary[]; overview: AccountOverview; error?: string }>(
      `/api/ledger/reconciliations?accountCode=${accountCode}`,
    ).then(({ ok, data }) => {
      if (token !== requestRef.current) return;
      // `ledger_account_missing` is the real case here: a chart of accounts
      // without ۱۱۱۰ cannot be reconciled, and an endless skeleton never said so.
      if (ok) {
        setHistory(data.reconciliations);
        setOverview(data.overview ?? null);
      } else {
        setHistory([]);
        setLoadFailed(true);
        setError(errorMessage(data.error));
      }
    });
  }, [accountCode]);

  useEffect(loadHistory, [loadHistory, refreshKey]);

  const current = useMemo(
    () => history?.find((r) => r.status === "in_progress") ?? null,
    [history],
  );
  const completed = useMemo(
    () => history?.filter((r) => r.status === "completed") ?? [],
    [history],
  );

  const currentId = current?.id ?? null;
  const loadDetail = useCallback(() => {
    if (!currentId) {
      setDetail(null);
      return;
    }
    const token = requestRef.current;
    setDetailLoading(true);
    api<ReconciliationDetail & { error?: string }>(`/api/ledger/reconciliations/${currentId}`).then(
      ({ ok, data }) => {
        if (token !== requestRef.current) return;
        setDetailLoading(false);
        if (ok) setDetail(data);
        // A failed detail load used to leave the skeleton up for ever, which
        // reads as "still loading" rather than "this did not load".
        else setError(errorMessage(data.error));
      },
    );
  }, [currentId]);

  useEffect(loadDetail, [loadDetail]);

  // A new reconciliation, a new list: the reader should not inherit the
  // previous one's search box or its «تطبیق‌شده» filter.
  useEffect(() => {
    setQuery("");
    setLineFilter("all");
    setVisibleCount(PAGE_SIZE);
  }, [currentId]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, lineFilter]);

  const lines = detail?.lines ?? [];
  const filteredLines = useMemo(
    () => filterReconciliationLines(lines, { query, filter: lineFilter, sourceLabel: ledgerSourceLabel }),
    [lines, query, lineFilter],
  );
  const visibleLines = filteredLines.slice(0, visibleCount);

  /**
   * The balances as *this screen* currently shows them. Recomputed from the
   * lines with `reconciliationBalances` — the same function the server checks a
   * `complete` against — so an optimistic tick moves the «مغایرت» card the
   * instant it is clicked instead of a round trip later.
   */
  const balances = useMemo(() => {
    if (!detail) return null;
    return reconciliationBalances({
      openingBalance: detail.openingBalance,
      statementBalance: detail.statementBalance,
      lines,
    });
  }, [detail, lines]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async function startReconciliation() {
    setFormError("");
    setError("");
    if (!statementDate) return setFormError(errorMessage("statement_date_required"));
    if (statementDate > todayIso()) return setFormError("تاریخ صورتحساب نمی‌تواند در آینده باشد.");
    if (overview?.lastStatementDate && statementDate < overview.lastStatementDate) {
      return setFormError(errorMessage("statement_date_before_last"));
    }
    let rial: number;
    try {
      rial = money.parse(statementBalance.trim() || "0");
    } catch {
      return setFormError(errorMessage("invalid_amount"));
    }
    const ok = await run(() =>
      api("/api/ledger/reconciliations", {
        method: "POST",
        body: JSON.stringify({ accountCode, statementDate, statementBalance: rial }),
      }),
    );
    if (ok) {
      setStatementDate("");
      setStatementBalance("");
      setNotice("تطبیق جدید آغاز شد؛ اقلام مطابق با صورتحساب را علامت بزنید.");
      setRefreshKey((k) => k + 1);
    }
  }

  /**
   * Clear or un-clear a set of lines.
   *
   * Optimistic: the checkboxes move now and the totals with them, then the
   * server's answer either confirms them or puts them back with the reason. A
   * tick that waits for a round trip before it appears is a tick the accountant
   * clicks twice.
   */
  const toggleLines = useCallback(
    async (ids: readonly string[], cleared: boolean) => {
      if (!detail || ids.length === 0) return;
      setError("");
      setNotice("");
      const idSet = new Set(ids);
      const before = detail.lines;
      setPendingLines(idSet);
      setDetail((prev) =>
        prev
          ? { ...prev, lines: prev.lines.map((l) => (idSet.has(l.journalLineId) ? { ...l, cleared } : l)) }
          : prev,
      );

      const { ok, data } = await api<{ error?: string }>(
        `/api/ledger/reconciliations/${detail.id}/lines`,
        { method: "PATCH", body: JSON.stringify({ journalLineIds: ids, cleared }) },
      );
      setPendingLines(new Set());
      if (!ok) {
        setDetail((prev) => (prev ? { ...prev, lines: before } : prev));
        setError(errorMessage(data.error));
        return;
      }
      // Re-read rather than trust the optimistic state: the opening balance and
      // the candidate set both belong to the server.
      loadDetail();
    },
    [detail, loadDetail],
  );

  async function complete() {
    if (!detail) return;
    setError("");
    const ok = await run(() =>
      api(`/api/ledger/reconciliations/${detail.id}/complete`, { method: "POST" }),
    );
    if (ok) {
      setNotice("تطبیق تکمیل و قفل شد.");
      setRefreshKey((k) => k + 1);
    }
  }

  async function cancelReconciliation() {
    if (!detail) return;
    setConfirmCancel(false);
    setError("");
    const ok = await run(() =>
      api(`/api/ledger/reconciliations/${detail.id}`, { method: "DELETE" }),
    );
    if (ok) {
      setNotice("تطبیق ناتمام لغو شد؛ اقلام آن دوباره قابل تطبیق هستند.");
      setRefreshKey((k) => k + 1);
    }
  }

  const activeMeta = RECONCILABLE_ACCOUNT_META[accountCode];
  const unclearedVisible = visibleLines.filter((l) => !l.cleared).map((l) => l.journalLineId);
  const clearedVisible = visibleLines.filter((l) => l.cleared).map((l) => l.journalLineId);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <section className="space-y-4" dir="rtl">
      <ErrorBox>{error}</ErrorBox>

      {notice ? (
        <Alert className="border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <CheckCircle2Icon className="text-emerald-700 dark:text-emerald-300" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-emerald-900 dark:text-emerald-100">
            <span>{notice}</span>
            <Button variant="ghost" size="xs" onClick={() => setNotice("")}>
              <XIcon /> بستن
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* -- Account picker ---------------------------------------------- */}
      <div className={cardClass}>
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کنترل وجوه</p>
          <h2 className="mt-1 text-base font-semibold text-foreground">تطبیق بانکی و صندوق</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            مانده صورتحساب هر حساب را با اقلام ثبت‌شده در دفاتر مقایسه کنید؛ وقتی مغایرت صفر شد، تطبیق را قفل کنید تا
            اقلام آن دیگر در تطبیق‌های بعدی نیایند.
          </p>
        </div>

        <div className="p-4 sm:p-5">
          {/*
            A wrapping row of pills, not a fixed three-column grid: three Persian
            labels in three ~100px phone columns were each clipped mid-word. Each
            pill carries its ledger code, which used to hide in a `title=` no
            touch device can show.
          */}
          <div role="group" aria-label="انتخاب حساب" className="flex flex-wrap gap-2">
            {RECONCILABLE_ACCOUNTS.map((code) => {
              const meta = RECONCILABLE_ACCOUNT_META[code];
              const Icon = ACCOUNT_ICONS[code];
              const isActive = accountCode === code;
              return (
                <button
                  key={code}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setAccountCode(code)}
                  className={`flex min-h-[52px] flex-1 basis-[10rem] items-center gap-2.5 rounded-xl border px-3 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 ${
                    isActive
                      ? "border-amber-200 bg-amber-100 text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)] dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                      : "border-border bg-card text-muted-foreground hover:bg-stone-50 hover:text-foreground dark:hover:bg-stone-800/40"
                  }`}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{meta.label}</span>
                    <span className="block truncate text-xs font-normal opacity-80">
                      حساب {toPersianDigits(meta.code)} — {meta.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* -- Account overview ------------------------------------------ */}
          {overview ? (
            <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="مانده دفتری حساب"
                value={money.format(overview.ledgerBalance)}
                hint={overview.accountName}
              />
              <StatCard
                label="مانده آخرین تطبیق"
                value={money.format(overview.openingBalance)}
                hint={
                  overview.lastStatementDate
                    ? `صورتحساب ${jalali(overview.lastStatementDate)}`
                    : "هنوز تطبیقی تکمیل نشده است"
                }
              />
              <StatCard
                label="اقلام تطبیق‌نشده"
                value={`${toPersianDigits(overview.unreconciledCount)} قلم`}
                hint="اقلامی که هیچ تطبیق تکمیل‌شده‌ای آن‌ها را نگرفته است"
                tone={overview.unreconciledCount > 0 ? "amber" : "muted"}
              />
              <StatCard
                label="خالص اقلام تطبیق‌نشده"
                value={money.format(overview.unreconciledTotal)}
                hint="بدهکار منهای بستانکار"
              />
            </dl>
          ) : null}
        </div>
      </div>

      {/* -- Body ---------------------------------------------------------- */}
      {loadFailed ? (
        <div className={`${cardClass} p-4 sm:p-5`}>
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>بارگذاری تطبیق‌های این حساب ناموفق بود</AlertTitle>
            <AlertDescription>
              اگر حساب «{activeMeta.label}» (کد {toPersianDigits(activeMeta.code)}) در سرفصل حساب‌ها تعریف نشده است،
              ابتدا آن را در «سرفصل حساب‌ها» بسازید.
            </AlertDescription>
          </Alert>
          <Button variant="outline" className="mt-3" onClick={() => setRefreshKey((k) => k + 1)}>
            <RefreshCwIcon /> تلاش دوباره
          </Button>
        </div>
      ) : !history ? (
        <div className={`${cardClass} p-4 sm:p-5`}>
          <LoadingSkeleton rows={4} label="در حال بارگذاری تطبیق‌های حساب" />
        </div>
      ) : !current ? (
        <StartForm
          accountLabel={activeMeta.label}
          overview={overview}
          statementDate={statementDate}
          onStatementDate={setStatementDate}
          statementBalance={statementBalance}
          onStatementBalance={setStatementBalance}
          unitLabel={money.unitLabel}
          error={formError}
          busy={busy}
          onSubmit={startReconciliation}
        />
      ) : !detail ? (
        <div className={`${cardClass} p-4 sm:p-5`}>
          <LoadingSkeleton rows={4} label="در حال بارگذاری اقلام تطبیق" />
        </div>
      ) : (
        <div className={cardClass}>
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  تطبیق جاری — {detail.accountLabel}
                </h3>
                <StatusBadge tone="active">در حال انجام</StatusBadge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                صورتحساب {jalali(detail.statementDate)} · مانده {money.format(detail.statementBalance)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* A busy *label*, never a spinner — docs/design-system.md §Charts and loading. */}
              <Button variant="ghost" size="sm" onClick={loadDetail} disabled={detailLoading}>
                <RefreshCwIcon /> {detailLoading ? "در حال نوسازی…" : "نوسازی"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmCancel(true)}
                disabled={busy}
              >
                <TrashIcon /> لغو تطبیق
              </Button>
            </div>
          </header>

          <div className="space-y-4 p-4 sm:p-5">
            {/* -- Balances ------------------------------------------------ */}
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="مانده اول دوره" value={money.format(detail.openingBalance)} hint="از آخرین تطبیق تکمیل‌شده" />
              <StatCard
                label="جمع اقلام تطبیق‌شده"
                value={money.format(balances?.clearedTotal ?? 0)}
                hint={`${toPersianDigits(balances?.clearedCount ?? 0)} قلم از ${toPersianDigits(lines.length)}`}
              />
              <StatCard
                label="مانده محاسبه‌شده"
                value={money.format(balances?.computedBalance ?? 0)}
                hint="مانده اول دوره + اقلام تطبیق‌شده"
              />
              <StatCard
                label="مغایرت"
                value={money.format(Math.abs(balances?.difference ?? 0))}
                hint={
                  !balances || balances.difference === 0
                    ? "صورتحساب و دفاتر برابرند"
                    : balances.difference > 0
                      ? "صورتحساب بیشتر از دفاتر است؛ قلمی علامت نخورده است"
                      : "دفاتر بیشتر از صورتحساب است؛ قلمی اضافه علامت خورده"
                }
                tone={!balances || balances.difference === 0 ? "positive" : "danger"}
              />
            </dl>

            {/* -- Toolbar ------------------------------------------------- */}
            {lines.length > 0 ? (
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="relative">
                    <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="جستجو در شرح، منبع یا مبلغ سند…"
                      aria-label="جستجو در اقلام تطبیق"
                      className="ps-9"
                    />
                  </div>
                  <div role="group" aria-label="فیلتر اقلام" className="flex gap-1 rounded-xl border border-border p-1">
                    {LINE_FILTERS.map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        aria-pressed={lineFilter === f.key}
                        onClick={() => setLineFilter(f.key)}
                        className={`min-h-9 flex-1 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 sm:flex-none ${
                          lineFilter === f.key
                            ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {toPersianDigits(filteredLines.length)} از {toPersianDigits(lines.length)} قلم
                  </span>
                  {query || lineFilter !== "all" ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setQuery("");
                        setLineFilter("all");
                      }}
                    >
                      <XIcon /> پاک کردن فیلترها
                    </Button>
                  ) : null}
                  <span className="grow" />
                  {/*
                    «انتخاب همه» is one PATCH carrying every visible id, not one
                    per line: a month of card settlements is 300 lines, and 300
                    sequential requests each re-reading the reconciliation was the
                    screen's slowest and most interruptible act.
                  */}
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={busy || pendingLines.size > 0 || unclearedVisible.length === 0}
                    onClick={() => toggleLines(unclearedVisible, true)}
                  >
                    <ListChecksIcon /> علامت‌زدن {toPersianDigits(unclearedVisible.length)} قلم نمایش‌داده‌شده
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy || pendingLines.size > 0 || clearedVisible.length === 0}
                    onClick={() => toggleLines(clearedVisible, false)}
                  >
                    <XIcon /> برداشتن علامت
                  </Button>
                </div>
              </div>
            ) : null}

            {/* -- Lines --------------------------------------------------- */}
            {lines.length === 0 ? (
              <EmptyState>
                سندی برای تطبیق تا تاریخ {jalali(detail.statementDate)} یافت نشد. اگر انتظار قلمی را دارید، تاریخ
                صورتحساب را بررسی کنید یا تطبیق را لغو و با تاریخ درست آغاز کنید.
              </EmptyState>
            ) : filteredLines.length === 0 ? (
              <EmptyState>قلمی با این جستجو یا فیلتر یافت نشد.</EmptyState>
            ) : (
              <>
                <LineTable
                  lines={visibleLines}
                  pending={pendingLines}
                  busy={busy}
                  money={money}
                  onToggle={(id, cleared) => toggleLines([id], cleared)}
                />
                <LineCards
                  lines={visibleLines}
                  pending={pendingLines}
                  busy={busy}
                  money={money}
                  onToggle={(id, cleared) => toggleLines([id], cleared)}
                />
                {filteredLines.length > visibleLines.length ? (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                  >
                    نمایش {toPersianDigits(Math.min(PAGE_SIZE, filteredLines.length - visibleLines.length))} قلم بیشتر
                  </Button>
                ) : null}
              </>
            )}

            {/* -- Complete ------------------------------------------------ */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-stone-50/60 p-3 dark:bg-stone-800/30">
              <p className="min-w-0 text-xs leading-5 text-muted-foreground">
                {balances && balances.difference === 0 ? (
                  <span className="font-medium text-emerald-700 dark:text-emerald-300">
                    مانده محاسبه‌شده با صورتحساب برابر است؛ می‌توانید تطبیق را قفل کنید.
                  </span>
                ) : (
                  <>
                    تا قفل‌شدن تطبیق، {money.format(Math.abs(balances?.difference ?? 0))} مغایرت باقی است. با علامت‌زدن یا
                    برداشتن علامت اقلام، مغایرت را به صفر برسانید.
                  </>
                )}
              </p>
              <Button
                onClick={complete}
                disabled={busy || !balances || balances.difference !== 0 || pendingLines.size > 0}
              >
                <CheckCircle2Icon /> تکمیل و قفل کردن تطبیق
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* -- History ------------------------------------------------------- */}
      {completed.length > 0 ? (
        <HistoryCard rows={completed} money={money} />
      ) : null}

      {/* -- Cancel confirmation ------------------------------------------- */}
      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>لغو تطبیق ناتمام؟</DialogTitle>
            <DialogDescription>
              تطبیق جاری حذف می‌شود و علامت‌های آن برداشته می‌شود؛ هیچ سند حسابداری‌ای تغییر نمی‌کند و اقلام دوباره در
              تطبیق بعدی همین حساب می‌آیند. تطبیق‌های قفل‌شده دست‌نخورده می‌مانند.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCancel(false)}>
              انصراف
            </Button>
            <Button variant="destructive" onClick={cancelReconciliation} disabled={busy}>
              <TrashIcon /> لغو تطبیق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  hint,
  tone = "muted",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "muted" | "amber" | "positive" | "danger";
}) {
  const toneClass =
    tone === "positive"
      ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/10"
      : tone === "danger"
        ? "border-destructive/30 bg-destructive/5"
        : tone === "amber"
          ? "border-amber-200 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10"
          : "border-border/80 bg-stone-50/60 dark:bg-stone-800/30";
  const valueClass =
    tone === "positive"
      ? "text-emerald-800 dark:text-emerald-200"
      : tone === "danger"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className={`min-w-0 rounded-xl border p-3 ${toneClass}`}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      {/* `break-words`, not `truncate`: a Rial figure is long and an amount
          silently cut off is worse than one on two lines. */}
      <dd className={`mt-1 text-sm font-bold break-words tabular-nums sm:text-base ${valueClass}`}>{value}</dd>
      {hint ? <p className="mt-1 text-xs leading-4 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function StartForm({
  accountLabel,
  overview,
  statementDate,
  onStatementDate,
  statementBalance,
  onStatementBalance,
  unitLabel,
  error,
  busy,
  onSubmit,
}: {
  accountLabel: string;
  overview: AccountOverview | null;
  statementDate: string;
  onStatementDate: (value: string) => void;
  statementBalance: string;
  onStatementBalance: (value: string) => void;
  unitLabel: string;
  error: string;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className={cardClass}>
      <header className="border-b border-border/80 px-4 py-4 sm:px-5">
        <h3 className="text-sm font-semibold text-foreground">شروع تطبیق جدید — {accountLabel}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          تاریخ پایان صورتحساب و مانده آن را وارد کنید. اقلام ثبت‌شده تا همان تاریخ که هنوز در تطبیق تکمیل‌شده‌ای نیامده‌اند،
          برای علامت‌زدن نمایش داده می‌شوند.
        </p>
      </header>
      {/*
        A real <form>: the old screen was two inputs and a button, so Enter in
        the balance field did nothing at all.
      */}
      <form
        className="space-y-4 p-4 sm:p-5"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {error ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">تاریخ صورتحساب</span>
            <JalaliDatePicker value={statementDate} onChange={onStatementDate} placeholder="انتخاب تاریخ" />
            <span className="mt-1 block text-xs text-muted-foreground">
              {overview?.lastStatementDate
                ? `آخرین تطبیق تکمیل‌شده: ${jalali(overview.lastStatementDate)}`
                : "اولین تطبیق این حساب"}
            </span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              مانده پایان صورتحساب ({unitLabel})
            </span>
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={statementBalance}
              onChange={(e) => onStatementBalance(e.target.value)}
              placeholder="۰"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              همان مبلغی که در انتهای صورتحساب بانک یا شمارش صندوق آمده است.
            </span>
          </label>
        </div>

        {overview && overview.unreconciledCount > 0 ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {toPersianDigits(overview.unreconciledCount)} قلم تطبیق‌نشده روی این حساب وجود دارد.
          </p>
        ) : null}

        <Button type="submit" size="lg" disabled={busy} className="w-full sm:w-auto">
          <BanknoteIcon /> شروع تطبیق جدید
        </Button>
      </form>
    </div>
  );
}

function LineTable({
  lines,
  pending,
  busy,
  money,
  onToggle,
}: {
  lines: readonly ReconciliationLine[];
  pending: ReadonlySet<string>;
  busy: boolean;
  money: ReturnType<typeof useMoney>;
  onToggle: (id: string, cleared: boolean) => void;
}) {
  return (
    <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">اقلام قابل تطبیق این حساب</caption>
          <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400">
            <tr className="border-b border-border">
              <th scope="col" className="px-4 py-3 text-start text-xs font-medium">
                تطبیق
              </th>
              <th scope="col" className="px-4 py-3 text-start text-xs font-medium">
                تاریخ
              </th>
              <th scope="col" className="px-4 py-3 text-start text-xs font-medium">
                منبع
              </th>
              <th scope="col" className="px-4 py-3 text-start text-xs font-medium">
                شرح
              </th>
              <th scope="col" className="px-4 py-3 text-start text-xs font-medium">
                بدهکار
              </th>
              <th scope="col" className="px-4 py-3 text-start text-xs font-medium">
                بستانکار
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr
                key={l.journalLineId}
                className={`border-b border-border last:border-b-0 ${
                  l.cleared ? "bg-emerald-50/50 dark:bg-emerald-500/5" : ""
                }`}
              >
                <td className="px-4 py-3">
                  <Checkbox
                    checked={l.cleared}
                    onCheckedChange={(value) => onToggle(l.journalLineId, value === true)}
                    disabled={busy || pending.has(l.journalLineId)}
                    /* A checkbox whose only label is «سند» tells a screen-reader
                       user nothing about which line they are ticking. */
                    aria-label={`تطبیق سند ${toPersianDigits(formatJalali(l.entryDate))} — ${
                      l.memo ?? ledgerSourceLabel(l.sourceType)
                    } — ${money.format(l.debit || l.credit)}`}
                  />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                  {toPersianDigits(formatJalali(l.entryDate))}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{ledgerSourceLabel(l.sourceType)}</td>
                <td className="px-4 py-3 text-foreground">{l.memo ?? "—"}</td>
                <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums text-foreground">
                  {l.debit ? money.format(l.debit) : "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums text-foreground">
                  {l.credit ? money.format(l.credit) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LineCards({
  lines,
  pending,
  busy,
  money,
  onToggle,
}: {
  lines: readonly ReconciliationLine[];
  pending: ReadonlySet<string>;
  busy: boolean;
  money: ReturnType<typeof useMoney>;
  onToggle: (id: string, cleared: boolean) => void;
}) {
  return (
    <div className="space-y-3 lg:hidden">
      {lines.map((l) => (
        /*
          A plain <div>, not a <label> wrapping the whole card: the old markup
          made every square millimetre — the amounts, the date, the source — a
          toggle for the checkbox, so reading a row with a thumb changed it.
          The checkbox has its own hit area and its own accessible name.
        */
        <div
          key={l.journalLineId}
          className={`rounded-xl border p-4 ${
            l.cleared
              ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/10"
              : "border-border/80 bg-stone-50/60 dark:bg-stone-800/30"
          }`}
        >
          <div className="flex items-start gap-3">
            <Checkbox
              className="mt-1 size-5"
              checked={l.cleared}
              onCheckedChange={(value) => onToggle(l.journalLineId, value === true)}
              disabled={busy || pending.has(l.journalLineId)}
              aria-label={`تطبیق سند ${toPersianDigits(formatJalali(l.entryDate))} — ${
                l.memo ?? ledgerSourceLabel(l.sourceType)
              } — ${money.format(l.debit || l.credit)}`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h4 className="min-w-0 text-sm font-semibold text-foreground">{l.memo ?? "—"}</h4>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {toPersianDigits(formatJalali(l.entryDate))}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{ledgerSourceLabel(l.sourceType)}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">بدهکار</dt>
                  <dd className="mt-1 font-semibold break-words tabular-nums text-foreground">
                    {l.debit ? money.format(l.debit) : "—"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">بستانکار</dt>
                  <dd className="mt-1 font-semibold break-words tabular-nums text-foreground">
                    {l.credit ? money.format(l.credit) : "—"}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function HistoryCard({
  rows,
  money,
}: {
  rows: readonly ReconciliationSummary[];
  money: ReturnType<typeof useMoney>;
}) {
  return (
    <div className={cardClass}>
      <header className="border-b border-border/80 px-4 py-4 sm:px-5">
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
        <h2 className="mt-1 text-base font-semibold text-foreground">تطبیق‌های قفل‌شده</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          اقلام این تطبیق‌ها قفل شده‌اند و در تطبیق‌های بعدی همین حساب نمی‌آیند.
        </p>
      </header>
      <div className="p-4 sm:p-5">
        <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
          <table className="w-full text-sm">
            <caption className="sr-only">تاریخچه تطبیق‌های تکمیل‌شده</caption>
            <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-3 text-start text-xs font-medium">
                  تاریخ صورتحساب
                </th>
                <th scope="col" className="px-4 py-3 text-start text-xs font-medium">
                  مانده صورتحساب
                </th>
                <th scope="col" className="px-4 py-3 text-start text-xs font-medium">
                  اقلام
                </th>
                <th scope="col" className="px-4 py-3 text-start text-xs font-medium">
                  تاریخ قفل‌شدن
                </th>
                <th scope="col" className="px-4 py-3 text-start text-xs font-medium">
                  وضعیت
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-b-0">
                  <td className="whitespace-nowrap px-4 py-3 text-foreground">{jalali(r.statementDate)}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-bold tabular-nums text-foreground">
                    {money.format(r.statementBalance)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {toPersianDigits(r.clearedCount)} قلم
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{jalali(r.completedAt)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge tone="positive">قفل‌شده</StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="space-y-3 lg:hidden">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl border border-border/80 bg-stone-50/60 p-3 dark:bg-stone-800/30">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{jalali(r.statementDate)}</span>
                <StatusBadge tone="positive">قفل‌شده</StatusBadge>
              </div>
              <p className="mt-2 font-bold break-words tabular-nums text-foreground">
                {money.format(r.statementBalance)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {toPersianDigits(r.clearedCount)} قلم · قفل‌شده در {jalali(r.completedAt)}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
