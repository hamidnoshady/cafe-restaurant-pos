import Link from "next/link";
import { SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiAttachmentChip, AiComposerTools } from "./ai-composer-tools";
import type { ChatAttachment, AssistantMode } from "./use-ai-chat";

interface AiChatInputProps {
  mode: AssistantMode;
  input: string;
  setInput: (value: string) => void;
  busy: boolean;
  canPropose: boolean;
  attachment: ChatAttachment | null;
  actionsAllowed: boolean;
  setActionsAllowed: (allowed: boolean) => void;
  attachReceiptImage: (file: File) => void;
  clearAttachment: () => void;
  loadConversation: (id: string) => void;
  sendMessage: (prompt?: string) => void;
}

export function AiChatInput({
  mode,
  input,
  setInput,
  busy,
  canPropose,
  attachment,
  actionsAllowed,
  setActionsAllowed,
  attachReceiptImage,
  clearAttachment,
  loadConversation,
  sendMessage,
}: AiChatInputProps) {
  return (
    <div className="border-t p-2">
      <AiAttachmentChip attachment={attachment} onClear={clearAttachment} />
      <div className="mb-1.5">
        <AiComposerTools
          mode={mode}
          canPropose={canPropose}
          disabled={busy}
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
              void sendMessage();
            }
          }}
          rows={1}
          disabled={busy}
          placeholder="پیام خود را بنویسید…"
          className="max-h-28 min-h-9 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30"
        />
        <Button
          size="icon"
          onClick={() => void sendMessage()}
          disabled={busy || !input.trim()}
          aria-label="ارسال پیام"
        >
          <SendIcon className="rtl:-scale-x-100" />
        </Button>
      </div>
      {mode === "floor" ? (
        <p className="mt-1 px-1 text-[10px] text-muted-foreground">
          این دستیار فقط راهنمایی و پیش‌نمایش می‌دهد؛ هیچ پرداخت، تقسیم یا
          تغییری ثبت نمی‌شود.
        </p>
      ) : (
        <p className="mt-1 px-1 text-[10px] text-muted-foreground">
          هزینهٔ هر پاسخ زیر همان پاسخ نوشته می‌شود؛ تغییرها فقط با تأیید شما ثبت
          می‌شوند.{" "}
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
