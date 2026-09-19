"use client";

import { cardClass, EmptyState, LoadingSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { Button } from "@/components/ui/button";
import { api, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import {
  MANUAL_LINES_MAX,
  MANUAL_MEMO_MAX,
  manualDocumentProblem,
  type ManualJournalProblem,
} from "@/lib/manual-journal";
import type { AccountRow, Runner } from "./accounting-manager";

interface DraftLineInput {
  accountId: string;
  side: "debit" | "credit";
  amount: string;
}

const EMPTY_LINE: DraftLineInput = { accountId: "", side: "debit", amount: "" };

/** A blank document: one debit row and one credit row, the shape of every entry. */
function blankLines(): DraftLineInput[] {
  return [
    { ...EMPTY_LINE, side: "debit" },
    { ...EMPTY_LINE, side: "credit" },
  ];
}

interface DraftLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}
interface JournalDraft {
  id: string;
  entryDate: string | null;
  memo: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  lines: DraftLine[];
}

const SIDE_OPTIONS = [
  { value: "debit", label: "بدهکار" },
  { value: "credit", label: "بستانکار" },
];

/**
 * What each refusal from `manualDocumentProblem` means to the person typing.
 * `not_balanced` is handled at the call site instead, because it can name the
 * actual difference — the one number that makes the problem fixable.
 */
const DOCUMENT_PROBLEM_TEXT: Record<ManualJournalProblem, string> = {
  no_lines: "حداقل دو ردیف کامل (حساب و مبلغ) لازم است.",
  too_few_lines: "حداقل دو ردیف کامل (حساب و مبلغ) لازم است.",
  too_many_lines: `تعداد ردیف‌ها بیش از حد مجاز (${toPersianDigits(String(MANUAL_LINES_MAX))} ردیف) است.`,
  single_account_entry: "سند باید حداقل به دو حساب متفاوت بخورد.",
  invalid_line: "یکی از ردیف‌ها معتبر نیست؛ حساب و مبلغ آن را بررسی کنید.",
  not_balanced: "سند متوازن نیست.",
};

/**
 * Generic balanced multi-line journal entry — covers both "manual expense
 * entry" (two lines: debit an expense account, credit Cash/Bank) and
 * anything else not auto-generated (e.g. settling tax payable: debit Tax
 * Payable, credit Cash/Bank). Submitting only drafts it — see the review
 * queue below, since posting it for real needs someone holding
 * ledger.approve (Phase 16's draft → review → post workflow).
 *
 * Two rules this screen has to keep, and the bugs that came from missing them:
 *
 *  - **The screen's arithmetic must be the server's.** The summary panel is the
 *    only check most people read before pressing «ثبت پیش‌نویس», so anything it
 *    calls «متوازن» has to be something the API will actually accept. It used
 *    to call a one-account document balanced, and a document whose amount field
 *    held unparseable text balanced-at-zero, and both came back as a red error
 *    under a green summary.
 *  - **A row is identified by identity, not by index.** The rows were keyed by
 *    array position, so deleting row 2 of 4 re-labelled every row under it and
 *    React re-used the deleted row's DOM node — the account you had picked in
 *    row 3 appeared to move up into the row you just emptied.
 */
export function ManualEntrySection({
  accounts,
  busy,
  run,
  refreshKey,
  canApprove,
  currentUserId,
}: {
  accounts: AccountRow[];
  busy: boolean;
  run: Runner;
  refreshKey: number;
  /**
   * Whether this member holds `ledger.approve`. The review queue's «تأیید و
   * ثبت» is that permission's button, not the app door's: a manager reaches
   * this screen and may draft, but approving answered 403 from a button that
   * looked live. Undefined means the page could not read the member's
   * permissions, in which case the button is drawn and the API stays the gate.
   */
  canApprove?: boolean;
  /**
   * Who is looking. `DELETE …/drafts/{id}` allows the drafter to discard their
   * own draft without `ledger.approve`, so «رد کردن» can only be hidden on
   * someone else's draft — hiding it on all of them would take away an action
   * the server permits.
   */
  currentUserId?: string;
}) {
  const money = useMoney();
  const formId = useId();
  const [memo, setMemo] = useState("");
  const [entryDate, setEntryDate] = useState("");
  /*
   * Each row carries its own `key`. See the docblock: an index key made React
   * re-use a removed row's DOM node, so the row *below* a deletion appeared to
   * inherit the deleted row's account.
   */
  const nextKey = useRef(0);
  const makeKey = () => `line-${nextKey.current++}`;
  const [lines, setLines] = useState<{ key: string; value: DraftLineInput }[]>(() =>
    blankLines().map((value) => ({ key: makeKey(), value })),
  );
  const [drafts, setDrafts] = useState<JournalDraft[] | null>(null);
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  /** The draft whose row action is in flight, so only its own buttons go busy. */
  const [pendingDraftId, setPendingDraftId] = useState<string | null>(null);
  /** The row a reviewer pressed «رد کردن» on — discarding is confirmed, not instant. */
  const [confirmRejectId, setConfirmRejectId] = useState<string | null>(null);

  const loadDrafts = useCallback(() => {
    let cancelled = false;
    api<{ drafts: JournalDraft[] }>("/api/ledger/entries/drafts").then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        setDrafts(data.drafts);
        setLocalError("");
      } else {
        // An endless skeleton reads as "still loading"; say what happened instead.
        setDrafts([]);
        setLocalError("بارگذاری پیش‌نویس‌ها ناموفق بود.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(loadDrafts, [loadDrafts, refreshKey]);

  /*
   * Only the *postable* accounts belong in the picker. A parent account
   * («۱۰۰۰ دارایی‌ها», «۵۰۰۰ هزینه‌ها») is a heading that totals its children;
   * posting to it is accepted by the database but corrupts every rollup that
   * sums children into a parent, and the chart-of-accounts screen already draws
   * the same distinction. `parent_code` is what the picker's own endpoint
   * returns, so the leaves are the codes nothing else names as a parent.
   */
  const postableAccounts = useMemo(() => {
    const parents = new Set(accounts.map((a) => a.parent_code).filter(Boolean));
    return accounts.filter((a) => !parents.has(a.code));
  }, [accounts]);

  const accountOptions = useMemo(
    () => [
      { value: "", label: "انتخاب حساب" },
      ...postableAccounts.map((a) => ({
        value: a.id,
        label: `${a.code} — ${a.name}`,
        // Searching the code *and* the name: an accountant types «۱۱۰۰», a
        // manager types «صندوق», and both should find the same row.
        searchString: `${a.code} ${a.name}`,
      })),
    ],
    [postableAccounts],
  );

  function updateLine(key: string, patch: Partial<DraftLineInput>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, value: { ...l.value, ...patch } } : l)));
  }
  function addLine() {
    setLines((prev) =>
      prev.length >= MANUAL_LINES_MAX ? prev : [...prev, { key: makeKey(), value: { ...EMPTY_LINE } }],
    );
  }
  function removeLine(key: string) {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((l) => l.key !== key)));
  }

  /*
   * The totals count only the rows that will actually be *submitted* — a row
   * needs both an account and an amount to become a line.
   *
   * Counting every row instead let the screen say «متوازن» for a document the
   * server was bound to refuse: type an amount, forget the account, and the
   * amount joined the total on screen but was filtered out of the payload, so
   * pressing «ثبت پیش‌نویس» returned `not_balanced` with the summary above it
   * still reading balanced. `incompleteLines` names that state instead.
   */
  const rows = lines.map((l) => l.value);
  /**
   * `null` for an amount the money parser refuses. It used to be coerced to 0,
   * so a typo («۱۲۳x۰۰۰», a pasted «۱۲۳٬۰۰۰ تومان») silently contributed
   * nothing to a total that still called itself balanced. A row that cannot be
   * read is a row the person has to fix, not a zero.
   */
  function amountOf(line: DraftLineInput): number | null {
    if (!line.amount.trim()) return null;
    try {
      const rial = money.parse(line.amount);
      return Number.isSafeInteger(rial) && rial > 0 ? rial : null;
    } catch {
      return null;
    }
  }

  const payloadLines = rows.filter((l) => l.accountId && amountOf(l) !== null);
  const incompleteLines = rows.filter(
    (l) => (l.accountId && !l.amount.trim()) || (!l.accountId && l.amount.trim()),
  ).length;
  /** Rows with an unreadable or non-positive amount — «۰», «-۵», «۱۲x». */
  const invalidAmountLines = rows.filter((l) => l.amount.trim() && amountOf(l) === null).length;

  /** The payload exactly as `submit` will send it, so the check below judges the real thing. */
  const journalLines = payloadLines.map((l) => {
    const rial = amountOf(l) ?? 0;
    return {
      accountId: l.accountId,
      debit: l.side === "debit" ? rial : 0,
      credit: l.side === "credit" ? rial : 0,
    };
  });

  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of journalLines) {
    totalDebit += l.debit;
    totalCredit += l.credit;
  }
  const difference = totalDebit - totalCredit;

  /*
   * The verdict comes from the same function the API validates with
   * (`@/lib/manual-journal`), not from a second implementation of the rules
   * here — a screen that grades a document more leniently than the server is
   * how «متوازن» ended up sitting above a `not_balanced` error.
   */
  const documentProblem = manualDocumentProblem(journalLines);
  const balanced = documentProblem === null;
  const memoTooLong = memo.trim().length > MANUAL_MEMO_MAX;
  const canSubmit = balanced && !!memo.trim() && !memoTooLong && invalidAmountLines === 0;

  /** Why «ثبت پیش‌نویس» is disabled, in the order a person would fix the problems. */
  const blockingReason = (() => {
    if (!memo.trim()) return "شرح سند را بنویسید.";
    if (memoTooLong)
      return `شرح سند حداکثر ${toPersianDigits(String(MANUAL_MEMO_MAX))} نویسه است.`;
    if (invalidAmountLines > 0)
      return `${toPersianDigits(String(invalidAmountLines))} ردیف مبلغ نامعتبر دارد؛ مبلغ باید عددی بزرگ‌تر از صفر باشد.`;
    if (documentProblem === "not_balanced")
      return `سند متوازن نیست؛ اختلاف ${money.format(Math.abs(difference))} ${
        difference > 0 ? "در سمت بدهکار" : "در سمت بستانکار"
      } است.`;
    return documentProblem ? DOCUMENT_PROBLEM_TEXT[documentProblem] : "";
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNotice("");
    setLocalError("");
    if (!canSubmit) return;
    const ok = await run(() =>
      api("/api/ledger/entries/drafts", {
        method: "POST",
        body: JSON.stringify({ memo: memo.trim(), entryDate: entryDate || undefined, lines: journalLines }),
      }),
    );
    if (ok) {
      setMemo("");
      setEntryDate("");
      setLines(blankLines().map((value) => ({ key: makeKey(), value })));
      // Saving used to look identical to nothing happening: the form emptied,
      // the new draft appeared somewhere down the page, and no word was said.
      setNotice("پیش‌نویس سند ثبت شد و در فهرست «در انتظار بررسی» پایین همین صفحه است.");
    }
  }

  async function approve(id: string) {
    setLocalError("");
    setNotice("");
    setPendingDraftId(id);
    const ok = await run(() => api(`/api/ledger/entries/drafts/${id}/approve`, { method: "POST" }));
    setPendingDraftId(null);
    if (ok) setNotice("سند تأیید و در دفاتر ثبت شد.");
  }

  async function reject(id: string) {
    setLocalError("");
    setNotice("");
    setPendingDraftId(id);
    // Through the shared runner, like approve: it surfaces the error and bumps
    // refreshKey, which refetches this queue — a rejected draft has to leave the
    // AI review queue too, not just this list.
    const ok = await run(() => api(`/api/ledger/entries/drafts/${id}`, { method: "DELETE" }));
    setPendingDraftId(null);
    setConfirmRejectId(null);
    if (ok) setNotice("پیش‌نویس رد و حذف شد.");
  }

  const hasNoPostableAccounts = postableAccounts.length === 0;

  return (
    <div className="space-y-4">
      <section aria-labelledby={`${formId}-heading`} className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سند دستی</p>
          <h2 id={`${formId}-heading`} className="mt-1 text-base font-semibold text-foreground">
            ثبت سند دستی (پیش‌نویس)
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            سند ابتدا به‌صورت پیش‌نویس ذخیره می‌شود و تا تأیید در فهرست پایین، اثری در دفاتر ندارد.
          </p>
        </header>

        {notice ? (
          <p
            role="status"
            className="mx-4 mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 sm:mx-5 dark:text-emerald-300"
          >
            {notice}
          </p>
        ) : null}

        {hasNoPostableAccounts ? (
          <p className="mx-4 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950 sm:mx-5 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200">
            هیچ حساب قابل ثبتی در سرفصل حساب‌ها وجود ندارد؛ ابتدا از «سرفصل حساب‌ها» حساب تعریف کنید.
          </p>
        ) : null}

        <form onSubmit={submit} className="space-y-4 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-foreground">شرح سند</span>
              <input
                className={inputClass}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="مثلاً: تسویه مالیات بر ارزش افزوده اسفند"
                maxLength={MANUAL_MEMO_MAX}
                required
                aria-describedby={`${formId}-memo-hint`}
              />
              <span id={`${formId}-memo-hint`} className="mt-1 block text-xs text-muted-foreground">
                {memoTooLong
                  ? `حداکثر ${toPersianDigits(String(MANUAL_MEMO_MAX))} نویسه.`
                  : "شرحی که بعداً در دفتر روزنامه خوانده می‌شود."}
              </span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-foreground">تاریخ سند</span>
              <JalaliDatePicker value={entryDate} onChange={setEntryDate} placeholder="امروز" />
              <span className="mt-1 block text-xs text-muted-foreground">خالی یعنی تاریخ امروز.</span>
            </label>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">ردیف‌های سند</h3>
              <span className="text-xs text-muted-foreground">
                حداقل دو ردیف روی دو حساب متفاوت لازم است
              </span>
            </div>

            {/* From `lg` up the rows read as one table with a single header, the
                way a voucher is written on paper; below that each row keeps its
                own labelled fields, because four inputs squeezed into a phone
                width is how a «طرف» select ends up 60px wide. */}
            <div
              className="hidden gap-3 px-3 text-xs font-medium text-muted-foreground lg:grid lg:grid-cols-[minmax(0,2fr)_9rem_minmax(0,1fr)_2.75rem]"
              aria-hidden="true"
            >
              <span>حساب</span>
              <span>طرف</span>
              <span>مبلغ ({money.unitLabel})</span>
              <span className="text-center">حذف</span>
            </div>

            <ul className="space-y-3">
              {lines.map(({ key, value: line }, i) => {
                const rowNumber = toPersianDigits(String(i + 1));
                const amount = amountOf(line);
                const amountInvalid = !!line.amount.trim() && amount === null;
                return (
                  <li
                    key={key}
                    className="rounded-xl border border-border/80 bg-muted/60 p-3 lg:border-transparent lg:bg-transparent lg:p-0 dark:lg:bg-transparent"
                  >
                    <p className="mb-2 text-xs font-semibold text-muted-foreground lg:hidden">
                      ردیف {rowNumber}
                    </p>
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_9rem_minmax(0,1fr)_2.75rem] lg:items-center lg:gap-3">
                      <label className="block">
                        <span className="mb-1.5 block text-sm font-medium text-foreground lg:sr-only">
                          حساب ردیف {rowNumber}
                        </span>
                        <SearchableSelect
                          value={line.accountId}
                          onChange={(v) => updateLine(key, { accountId: v })}
                          options={accountOptions}
                          ariaLabel={`حساب ردیف ${rowNumber}`}
                          searchPlaceholder="کد یا نام حساب…"
                          disabled={hasNoPostableAccounts}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-sm font-medium text-foreground lg:sr-only">
                          طرف ردیف {rowNumber}
                        </span>
                        <SearchableSelect
                          value={line.side}
                          onChange={(v) => updateLine(key, { side: v as "debit" | "credit" })}
                          options={SIDE_OPTIONS}
                          ariaLabel={`طرف ردیف ${rowNumber}`}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-sm font-medium text-foreground lg:sr-only">
                          مبلغ ردیف {rowNumber} ({money.unitLabel})
                        </span>
                        <PersianNumberInput
                          className={inputClass}
                          dir="ltr"
                          inputMode="numeric"
                          allowDecimal={false}
                          allowNegative={false}
                          value={line.amount}
                          onChange={(e) => updateLine(key, { amount: e.target.value })}
                          placeholder="۰"
                          aria-label={`مبلغ ردیف ${rowNumber} به ${money.unitLabel}`}
                          aria-invalid={amountInvalid || undefined}
                        />
                      </label>
                      {/* An icon-only control on a 44px target — a full «حذف»
                          button per row pushed the amount field off a phone. */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeLine(key)}
                        disabled={lines.length <= 2}
                        aria-label={`حذف ردیف ${rowNumber}`}
                        title={lines.length <= 2 ? "سند باید حداقل دو ردیف داشته باشد" : "حذف این ردیف"}
                        className="justify-self-end text-muted-foreground hover:text-destructive lg:justify-self-center"
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>

            <SecondaryButton onClick={addLine} disabled={lines.length >= MANUAL_LINES_MAX}>
              <PlusIcon aria-hidden="true" className="size-4" />
              افزودن ردیف
            </SecondaryButton>
          </div>

          <div className="rounded-xl border border-border/80 bg-muted/60 p-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">جمع بدهکار</dt>
                <dd className="mt-1 font-bold tabular-nums text-foreground">{money.format(totalDebit)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">جمع بستانکار</dt>
                <dd className="mt-1 font-bold tabular-nums text-foreground">{money.format(totalCredit)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">وضعیت سند</dt>
                <dd className="mt-1">
                  <StatusBadge tone={balanced ? "positive" : "neutral"}>
                    {balanced ? "متوازن" : "در انتظار توازن"}
                  </StatusBadge>
                </dd>
                {/* The difference, not just "not balanced yet": the number a
                    person needs in order to fix it was the one thing the
                    summary never said. */}
                {!balanced && difference !== 0 ? (
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    اختلاف: <span className="tabular-nums">{money.format(Math.abs(difference))}</span>
                    {difference > 0 ? " (بدهکار بیشتر است)" : " (بستانکار بیشتر است)"}
                  </p>
                ) : null}
              </div>
            </dl>
            {/* One live region for everything the summary has to say, so a
                screen reader hears the balance change as it is typed. */}
            <div role="status" aria-live="polite" className="empty:hidden">
              {incompleteLines > 0 ? (
                <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
                  {toPersianDigits(String(incompleteLines))} ردیف ناقص است (حساب یا مبلغ ندارد) و در سند ثبت نمی‌شود.
                </p>
              ) : null}
              {invalidAmountLines > 0 ? (
                <p className="mt-1 text-xs leading-5 text-destructive">
                  {toPersianDigits(String(invalidAmountLines))} ردیف مبلغ نامعتبر دارد؛ مبلغ باید عددی بزرگ‌تر از صفر باشد.
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[12rem] flex-1 sm:max-w-xs">
              <PrimaryButton disabled={busy || !canSubmit}>
                {busy ? "در حال ثبت…" : "ثبت پیش‌نویس"}
              </PrimaryButton>
            </div>
            {/* A disabled button with no reason beside it is the screen refusing
                to say what is wrong. */}
            {blockingReason && !busy ? (
              <p className="text-xs leading-5 text-muted-foreground">{blockingReason}</p>
            ) : null}
          </div>
        </form>
      </section>

      <section aria-labelledby={`${formId}-queue-heading`} className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کنترل و تأیید</p>
          <h2 id={`${formId}-queue-heading`} className="mt-1 text-base font-semibold text-foreground">
            پیش‌نویس‌های در انتظار بررسی
            {drafts && drafts.length > 0 ? (
              <span className="ms-2 text-sm font-normal text-muted-foreground">
                ({toPersianDigits(String(drafts.length))} سند)
              </span>
            ) : null}
          </h2>
          {canApprove === false ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              شما دسترسی «تأیید سند» ندارید؛ می‌توانید پیش‌نویس ثبت کنید و پیش‌نویس‌های خودتان را رد کنید.
            </p>
          ) : null}
        </header>
        <div className="p-4 sm:p-5">
          {localError ? (
            <p role="alert" className="mb-3 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {localError}
            </p>
          ) : null}
          {!drafts ? (
            <LoadingSkeleton rows={3} label="در حال بارگذاری پیش‌نویس‌ها" />
          ) : drafts.length === 0 ? (
            <EmptyState>پیش‌نویسی در انتظار بررسی وجود ندارد.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {drafts.map((d) => {
                const rowBusy = pendingDraftId === d.id;
                const total = d.lines.reduce((sum, l) => sum + l.debit, 0);
                const confirming = confirmRejectId === d.id;
                // Mirrors the DELETE route: your own draft, or ledger.approve.
                const canReject =
                  canApprove !== false || (!!currentUserId && d.createdBy === currentUserId);
                return (
                  <li key={d.id} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        {/* `break-words`: a long memo used to run past the card
                            on a phone instead of wrapping. */}
                        <h3 className="text-sm font-semibold break-words text-foreground">{d.memo}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {d.entryDate ? toPersianDigits(formatJalali(d.entryDate)) : "بدون تاریخ (امروز)"}
                          {d.createdByName ? ` — ${d.createdByName}` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-bold tabular-nums text-foreground">
                        {money.format(total)}
                      </span>
                    </div>

                    <div className="mt-3 space-y-2">
                      <div
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b border-border pb-1 text-xs text-muted-foreground"
                        aria-hidden="true"
                      >
                        <span>حساب</span>
                        <span className="text-end">بدهکار</span>
                        <span className="text-end">بستانکار</span>
                      </div>
                      {d.lines.map((l, i) => (
                        <div
                          key={`${d.id}-${i}`}
                          className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-t border-border pt-2 text-sm first:border-t-0 first:pt-0"
                        >
                          <span className="min-w-0 break-words text-muted-foreground">
                            {l.accountCode} {l.accountName}
                          </span>
                          <span className="whitespace-nowrap tabular-nums text-foreground">
                            {l.debit ? money.format(l.debit) : "—"}
                          </span>
                          <span className="whitespace-nowrap tabular-nums text-foreground">
                            {l.credit ? money.format(l.credit) : "—"}
                          </span>
                        </div>
                      ))}
                    </div>

                    {confirming ? (
                      /* Discarding a draft is irreversible and «رد کردن» sat
                         one tap from «تأیید و ثبت»; it asks first now. */
                      <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                        <p className="text-sm text-destructive">
                          این پیش‌نویس حذف شود؟ این کار قابل بازگشت نیست.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={() => reject(d.id)}
                            disabled={busy || rowBusy}
                          >
                            {rowBusy ? "در حال حذف…" : "بله، حذف کن"}
                          </Button>
                          <SecondaryButton onClick={() => setConfirmRejectId(null)} disabled={rowBusy}>
                            انصراف
                          </SecondaryButton>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {canApprove === false ? null : (
                          <div className="min-w-40 flex-1 sm:max-w-xs">
                            <PrimaryButton
                              type="button"
                              onClick={() => approve(d.id)}
                              disabled={busy || rowBusy}
                            >
                              {rowBusy ? "در حال ثبت…" : "تأیید و ثبت"}
                            </PrimaryButton>
                          </div>
                        )}
                        {canReject ? (
                          <SecondaryButton onClick={() => setConfirmRejectId(d.id)} disabled={busy || rowBusy}>
                            رد کردن
                          </SecondaryButton>
                        ) : (
                          <p className="text-xs leading-6 text-muted-foreground">
                            بررسی این پیش‌نویس با دارندهٔ دسترسی «تأیید سند» است.
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
