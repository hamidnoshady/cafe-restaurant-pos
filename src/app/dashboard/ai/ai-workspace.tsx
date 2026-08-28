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

import { useState } from "react";
import { useAiChat } from "@/components/ai/use-ai-chat";
import { AiChatHub } from "./ai-chat-hub";
import { AiSidebar } from "./ai-sidebar";

export function AiWorkspace() {
  const chat = useAiChat({ mode: "dashboard" });
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Desktop rail */}
      <aside className="hidden w-72 shrink-0 border-l border-stone-200/80 md:block">
        <AiSidebar chat={chat} onNavigate={() => setNavOpen(false)} />
      </aside>

      {/* Mobile drawer */}
      {navOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="بستن منو"
            className="absolute inset-0 bg-black/40"
            onClick={() => setNavOpen(false)}
          />
          <div className="absolute inset-y-0 right-0 w-[82%] max-w-xs shadow-[0_1px_2px_rgb(41_37_36/0.035)]">
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
