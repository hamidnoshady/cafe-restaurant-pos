"use client";

/**
 * The floating launcher's composer — the shared `ChatComposer` in popup
 * sizing plus the mode-specific fine print under the field.
 */
import { ChatComposer } from "./chat-composer";
import type { AiTaskId } from "@/lib/ai-tasks";
import type { AssistantMode, ChatAttachment } from "./use-ai-chat";

interface AiChatInputProps {
  mode: AssistantMode;
  input: string;
  setInput: (value: string) => void;
  busy: boolean;
  canPropose: boolean;
  attachments: ChatAttachment[];
  onAttachFiles: (files: File[]) => void;
  onClearAttachment: (id?: string) => void;
  task: AiTaskId;
  onTaskChange: (id: AiTaskId) => void;
  customTask: string;
  onCustomTaskChange: (text: string) => void;
  actionsAllowed: boolean;
  setActionsAllowed: (allowed: boolean) => void;
  loadConversation: (id: string) => void;
  sendMessage: (prompt?: string) => void;
}

export function AiChatInput({
  mode,
  input,
  setInput,
  busy,
  canPropose,
  attachments,
  onAttachFiles,
  onClearAttachment,
  task,
  onTaskChange,
  customTask,
  onCustomTaskChange,
  actionsAllowed,
  setActionsAllowed,
  loadConversation,
  sendMessage,
}: AiChatInputProps) {
  return (
    <div className="border-t border-border/70 bg-card/90 p-2 pt-2.5 backdrop-blur">
      <ChatComposer
        variant="popup"
        mode={mode}
        input={input}
        setInput={setInput}
        busy={busy}
        canPropose={canPropose}
        attachments={attachments}
        onAttachFiles={onAttachFiles}
        onClearAttachment={onClearAttachment}
        task={task}
        onTaskChange={onTaskChange}
        customTask={customTask}
        onCustomTaskChange={onCustomTaskChange}
        actionsAllowed={actionsAllowed}
        setActionsAllowed={setActionsAllowed}
        loadConversation={loadConversation}
        sendMessage={sendMessage}
        footer={
          mode === "floor" ? (
            <p className="mt-1.5 px-1.5 text-[10px] text-muted-foreground">
              این دستیار فقط راهنمایی و پیش‌نمایش می‌دهد؛ هیچ پرداخت، تقسیم یا
              تغییری ثبت نمی‌شود.
            </p>
          ) : (
            <p className="mt-1.5 px-1.5 text-[10px] text-muted-foreground">
              هزینهٔ هر پاسخ زیر همان پاسخ نوشته می‌شود؛ تغییرها فقط با تأیید شما ثبت
              می‌شوند.
            </p>
          )
        }
      />
    </div>
  );
}
