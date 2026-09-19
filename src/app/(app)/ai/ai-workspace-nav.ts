/**
 * The AI Workspace's own section menu (Phase I — UI redesign / IA).
 *
 * Until now `/ai` was a single ChatGPT-like page and every other AI surface the
 * product had *shipped* — the coworker's inbox and jobs (Phase 32), the
 * automation engine (Phase D), the autopilot activity feed — either lived
 * nowhere reachable or was buried inside a component no route mounted. The
 * audit named this the Phase I gap: the engines exist, the UI to run them does
 * not. This registry is the backbone that fixes it — one place that answers
 * "what sections does the AI Workspace have, what are they called, and who may
 * open them", read by both the chat rail (which links the other sections) and
 * each management page (which draws the shared sub-nav and gates itself).
 *
 * Framework-free by the same rule as `apps.ts` / `growth-routes.ts` (no `next`,
 * no `db`, no JSX): the list is data, so the server pages, the client rail and
 * the unit tests all read one source of truth and a section's name can never
 * drift between the menu and the page it opens.
 *
 * Every section is a management surface, so every one is owner/manager — the
 * same gate `/ai/page.tsx` already applies. The whole workspace is additionally
 * behind the `ai_assistant` feature lock at the page level; this module answers
 * only "which role may see the section", not "does the business have AI".
 */

export const AI_WORKSPACE_SECTION_KEYS = [
  "chat",
  "agents",
  "coworkers",
  "automations",
  "activity",
  "usage",
] as const;

export type AiWorkspaceSectionKey = (typeof AI_WORKSPACE_SECTION_KEYS)[number];

export interface AiWorkspaceSection {
  key: AiWorkspaceSectionKey;
  /** The section's name, as the rail and the page header both call it. */
  label: string;
  /** One line under the label — the rail's help text. */
  description: string;
  /** The public route the section lives at. */
  href: string;
  /** lucide-react icon name, resolved to a component by the client nav. */
  icon: AiWorkspaceIconName;
}

/**
 * The icons the workspace nav uses, named rather than imported so this module
 * stays framework-free (a `LucideIcon` import would pull React into a file the
 * Edge route helpers and unit tests read). The client nav maps these back to
 * the real components.
 */
export type AiWorkspaceIconName =
  | "chat"
  | "agents"
  | "coworkers"
  | "automations"
  | "activity"
  | "usage";

/** The workspace's sections, in menu order. Chat is the workspace home. */
export const AI_WORKSPACE_SECTIONS: readonly AiWorkspaceSection[] = [
  {
    key: "chat",
    label: "گفت‌وگو",
    description: "دستیار هوشمند: بپرس، بسپار، تأیید کن",
    href: "/ai",
    icon: "chat",
  },
  {
    key: "agents",
    label: "ایجنت‌ها",
    description: "دستیارهای سفارشی: نقش، ابزارها و اجازهٔ عملیات",
    href: "/ai/agents",
    icon: "agents",
  },
  {
    key: "coworkers",
    label: "همکاران هوشمند",
    description: "کارهای تکرارشونده که سپرده‌اید و صندوق تصمیم‌ها",
    href: "/ai/coworkers",
    icon: "coworkers",
  },
  {
    key: "automations",
    label: "اتوماسیون‌ها",
    description: "قاعده‌های «هر وقت… اگر… آنگاه…» کسب‌وکار",
    href: "/ai/automations",
    icon: "automations",
  },
  {
    key: "activity",
    label: "فعالیت خودکار",
    description: "آنچه دستیار خودکار انجام داده یا برای تأیید گذاشته",
    href: "/ai/activity",
    icon: "activity",
  },
  {
    key: "usage",
    label: "مصرف و هزینه",
    description: "هزینهٔ هوش مصنوعی: چقدر، کجا و با چه مدلی خرج شده",
    href: "/ai/usage",
    icon: "usage",
  },
];

/** Look a section up by key. */
export function aiWorkspaceSection(key: AiWorkspaceSectionKey): AiWorkspaceSection {
  const section = AI_WORKSPACE_SECTIONS.find((item) => item.key === key);
  if (!section) throw new Error(`unknown AI workspace section: ${key}`);
  return section;
}

/**
 * Whether a role may open a workspace section. Every section is management
 * work — the same rule `/ai` itself applies (owner or manager only) — so a
 * cashier or accountant never sees the workspace. Kept as a function, not a
 * constant, so a future per-section rule (say, a read-only activity view for
 * accountants) has one place to live.
 */
export function canViewAiWorkspaceSection(role: string, _key: AiWorkspaceSectionKey): boolean {
  return role === "owner" || role === "manager";
}

/** Whether a role has at least one workspace section to open. */
export function canOpenAiWorkspace(role: string): boolean {
  return AI_WORKSPACE_SECTION_KEYS.some((key) => canViewAiWorkspaceSection(role, key));
}

/**
 * Whether a pathname *is* a given section — the nav's idea of "you are here".
 *
 * Chat is the workspace root (`/ai`), so it lights up only on that exact path;
 * a management section lights up on its page and anything nested under it.
 * Without the exact match on chat, every `/ai/*` page would also highlight
 * «گفت‌وگو» and the menu would have two active answers at once.
 */
export function isAiWorkspaceSectionPathname(
  pathname: string,
  key: AiWorkspaceSectionKey,
): boolean {
  const { href } = aiWorkspaceSection(key);
  if (key === "chat") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The active section for a pathname, or null if it is not a workspace path.
 * Longest-href-first so `/ai/coworkers` matches «همکاران هوشمند» rather than
 * the chat root's `/ai` prefix.
 */
export function activeAiWorkspaceSection(pathname: string): AiWorkspaceSectionKey | null {
  const nonChat = AI_WORKSPACE_SECTIONS.filter((section) => section.key !== "chat");
  for (const section of nonChat) {
    if (isAiWorkspaceSectionPathname(pathname, section.key)) return section.key;
  }
  if (isAiWorkspaceSectionPathname(pathname, "chat")) return "chat";
  return null;
}
