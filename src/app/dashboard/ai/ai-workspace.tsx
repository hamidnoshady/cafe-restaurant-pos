"use client";

/**
 * The AI assistant as a standalone, ChatGPT-like workspace (Phase 36b revision).
 *
 * A conversation rail on the side (its own nav, separate from the user-built
 * mobile bottom bar), a scrollable chat thread, and a bottom composer — all
 * responsive: the rail is a fixed column from `md` up and a slide-over drawer on
 * phones. The conversation state lives here and is shared with both the rail and
 * the chat panel, so picking a thread in the rail switches the panel instantly.
 */

import { useEffect, useState } from "react";
import { useAiChat } from "@/components/ai/use-ai-chat";
import { AiChatHub } from "./ai-chat-hub";
import { AiSidebar } from "./ai-sidebar";
import { overlayPanelClass } from "../page-chrome";

export function AiWorkspace() {
  const chat = useAiChat({ mode: "dashboard" });
  const [navOpen, setNavOpen] = useState(false);

  // The drawer is a modal layer, so it owes the two things every modal owes:
  // Escape closes it, and the page underneath stops scrolling while it is up.
  // Without either, the only way out on a phone was to find the small ✕ or to
  // hit the scrim exactly, and flicking the conversation list scrolled the chat
  // thread behind it instead.
  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [navOpen]);

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Desktop rail. The border is logical (`border-e`), so the rail's inner
          edge stays its inner edge if the shell is ever rendered LTR. */}
      <aside className="hidden w-72 shrink-0 border-e border-border/80 md:block">
        <AiSidebar chat={chat} onNavigate={() => setNavOpen(false)} />
      </aside>

      {/* Mobile drawer */}
      {navOpen ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="مکالمه‌ها">
          <button
            type="button"
            aria-label="بستن منو"
            className="absolute inset-0 bg-black/40"
            onClick={() => setNavOpen(false)}
          />
          <div
            className={`absolute inset-y-0 right-0 flex w-[86%] max-w-xs flex-col ${overlayPanelClass} rounded-none border-y-0 border-e-0`}
          >
            <AiSidebar chat={chat} onNavigate={() => setNavOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <AiChatHub chat={chat} onOpenNav={() => setNavOpen(true)} />
      </div>
    </div>
  );
}
