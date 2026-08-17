import Link from "next/link";
import { Loader2Icon, SendIcon } from "lucide-react";
import { formatToman } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { AiAttachmentChip, AiComposerTools } from "./ai-composer-tools";
import type { ChatAttachment, PendingTurn, AssistantMode } from "./use-ai-chat";

interface AiChatInputProps {
  mode: AssistantMode;
  input: string;
  setInput: (value: string) => void;
  busy: boolean;
  estimating: boolean;
  pending: PendingTurn | null;
  canPropose: boolean;
  attachment: ChatAttachment | null;
  actionsAllowed: boolean;
  setActionsAllowed: (allowed: boolean) => void;
  attachReceiptImage: (file: File) => void;
  clearAttachment: () => void;
  loadConversation: (id: string) => void;
  prepareSend: (prompt?: string) => void;
  cancelPending: () => void;
  startStream: (text: string) => void;
}

export function AiChatInput({
  mode,
  input,
  setInput,
  busy,
  estimating,
  pending,
  canPropose,
  attachment,
  actionsAllowed,
  setActionsAllowed,
  attachReceiptImage,
  clearAttachment,
  loadConversation,
  prepareSend,
  cancelPending,
  startStream,
}: AiChatInputProps) {
  return (
    <div className="border-t p-2">
      {pending ? (
        <div className="mb-2 rounded-xl border border-primary/25 bg-primary/5 p-2.5 text-xs">
          <p className="font-semibold text-foreground">
            برآورد هزینه: {formatToman(pending.estimate.estimatedCostRial)}
          </p>
          <p className="mt-1 leading-5 text-muted-foreground">
            بر پایهٔ {pending.estimate.assumedToolRounds} نوبت پاسخ/ابزار محاسبه
            شده است. حداکثر رزرو این درخواست:{" "}
            {formatToman(pending.estimate.maximumReservationRial)}؛ مبلغ نهایی
            بر اساس مصرف واقعی تسویه می‌شود.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={() => void startStream(pending.text)}
              disabled={busy}
            >
              <SendIcon className="rtl:-scale-x-100" /> شروع پاسخ
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={cancelPending}
              disabled={busy}
            >
              ویرایش
            </Button>
          </div>
        </div>
      ) : null}
      <AiAttachmentChip attachment={attachment} onClear={clearAttachment} />
      <div className="mb-1.5">
        <AiComposerTools
          mode={mode}
          canPropose={canPropose}
          disabled={busy || estimating || Boolean(pending)}
          onAttach={(file) => void attachReceiptImage(file)}
          actionsAllowed={actionsAllowed}
          onActionsAllowedChange={setActionsAllowed}
          onSelectConversation={(id) => void loadConversation(id)}
          onSelectReportPrompt={(prompt) => setInput(prompt)}
        />
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void prepareSend();
            }
          }}
          rows={1}
          disabled={busy || estimating || Boolean(pending)}
          placeholder={
            estimating ? "در حال محاسبهٔ برآورد…" : "پیام خود را بنویسید…"
          }
          className="max-h-28 min-h-9 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30"
        />
        <Button
          size="icon"
          onClick={() => void prepareSend()}
          disabled={busy || estimating || Boolean(pending) || !input.trim()}
          aria-label="ارسال پیام"
        >
          {estimating ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <SendIcon className="rtl:-scale-x-100" />
          )}
        </Button>
      </div>
      {mode === "floor" ? (
        <p className="mt-1 px-1 text-[10px] text-muted-foreground">
          این دستیار فقط راهنمایی و پیش‌نمایش می‌دهد؛ هیچ پرداخت، تقسیم یا
          تغییری ثبت نمی‌شود.
        </p>
      ) : (
        <p className="mt-1 px-1 text-[10px] text-muted-foreground">
          هزینهٔ تخمینی پیش از ارسال نشان داده می‌شود؛ تغییرها فقط با تأیید شما
          ثبت می‌شوند.{" "}
          <Link
            href="/dashboard/ai?tab=settings"
            className="underline underline-offset-2 hover:text-foreground"
          >
            اعتبار، اشتراک و گزارش ممیزی
          </Link>
        </p>
      )}
    </div>
  );
}
