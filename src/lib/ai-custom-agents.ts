/**
 * Phase D (unified entity model) — the pure core of the custom Agent.
 *
 * A *custom agent* is a business-defined lens over the SAME dashboard
 * assistant: its own name, its own instructions (a system-prompt fragment),
 * and two allowlists that NARROW what a chat turn run as this agent may see and
 * do. It adds no new tool, no new action and no new mutation path — a turn run
 * as an agent still emits `propose_action`, still lands in the confirm loop,
 * and still applies through the same role-guarded route with the user's own
 * session. The agent only decides which subset of the already-existing,
 * already-guarded catalogue the model is allowed to name.
 *
 * Everything here is framework-free — no DB, no provider, no `next/*` — so the
 * validation rules can be unit-tested in isolation and reused by both the HTTP
 * route (on write) and the chat runtime (on read). Persistence lives in
 * `ai-custom-agents-service.ts`.
 *
 * The two allowlists are validated against the LIVE catalogue, never a frozen
 * copy: the read tools come from `toolDefinitions("dashboard")` and the actions
 * from `ACTION_CATALOG`, so a tool or action that is renamed or removed cannot
 * linger in an agent's allowlist and quietly do nothing.
 */
import {
  ACTION_CATALOG,
  isKnownAction,
  toolDefinitions,
  type ActionType,
} from "./ai";

export const MAX_AGENT_NAME = 80;
export const MAX_AGENT_INSTRUCTIONS = 4000;

/** A custom agent as stored and returned by the service. */
export interface CustomAgent {
  id: string;
  businessId: string;
  name: string;
  instructions: string;
  toolAllowlist: string[];
  actionAllowlist: ActionType[];
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The writable shape a route hands to the service (create or update). */
export interface CustomAgentInput {
  name?: unknown;
  instructions?: unknown;
  toolAllowlist?: unknown;
  actionAllowlist?: unknown;
  enabled?: unknown;
}

/** A validated, normalized agent write — what actually reaches the database. */
export interface NormalizedCustomAgent {
  name: string;
  instructions: string;
  toolAllowlist: string[];
  actionAllowlist: ActionType[];
  enabled: boolean;
}

export type CustomAgentValidation =
  | { ok: true; value: NormalizedCustomAgent }
  | { ok: false; errors: string[] };

/**
 * The read tools an agent may allow — exactly the dashboard assistant's own
 * read surface, minus `propose_action` (which the action allowlist governs) and
 * minus the attachment-only receipt drafter (offered per-turn, not per-agent).
 * Derived from `toolDefinitions` so it can never drift from what the runtime
 * actually offers.
 */
export function selectableAgentTools(): string[] {
  return toolDefinitions("dashboard", { hasAttachment: false, retrieval: true })
    .map((tool) => tool.function.name)
    .filter((name) => name !== "propose_action");
}

/**
 * The actions an agent may allow — every catalogue action a human can apply
 * from the chat, minus the coworker-only ones (which only a pre-authored
 * coworker job may ever name). This is the same boundary
 * `assertWriteToolsMatchCatalogue` draws for MCP writes, kept in one place.
 */
export function selectableAgentActions(): ActionType[] {
  return (Object.keys(ACTION_CATALOG) as ActionType[]).filter(
    (type) => !ACTION_CATALOG[type].coworkerOnly,
  );
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const value = String(entry ?? "").trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/**
 * Validate and normalize an agent write. Rejects — rather than silently
 * dropping — an unknown tool or action, because an allowlist that quietly
 * ignores what it does not recognise is an allowlist the owner cannot trust.
 */
export function validateCustomAgent(input: CustomAgentInput): CustomAgentValidation {
  const errors: string[] = [];

  const name = String(input.name ?? "").trim();
  if (!name) errors.push("name_required");
  else if (name.length > MAX_AGENT_NAME) errors.push("name_too_long");

  const instructions = String(input.instructions ?? "").trim();
  if (instructions.length > MAX_AGENT_INSTRUCTIONS) errors.push("instructions_too_long");

  const selectableTools = new Set(selectableAgentTools());
  const toolAllowlist = normalizeStringArray(input.toolAllowlist);
  for (const tool of toolAllowlist) {
    if (!selectableTools.has(tool)) errors.push(`unknown_tool:${tool}`);
  }

  const selectableActions = new Set<string>(selectableAgentActions());
  const actionAllowlist = normalizeStringArray(input.actionAllowlist);
  for (const action of actionAllowlist) {
    if (!isKnownAction(action) || !selectableActions.has(action)) {
      errors.push(`unknown_action:${action}`);
    }
  }

  const enabled = input.enabled === undefined ? true : input.enabled === true;

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      instructions,
      toolAllowlist,
      actionAllowlist: actionAllowlist as ActionType[],
      enabled,
    },
  };
}

/**
 * The scope a chat turn adopts when it runs as an agent. `null` action list
 * would mean "no restriction"; an agent ALWAYS restricts, so this is always a
 * concrete (possibly empty) set. An empty action list is a read-only agent.
 */
export interface AgentTurnScope {
  id: string;
  name: string;
  instructions: string;
  /** Read-tool names this turn may call; the runtime intersects with the mode's own set. */
  toolAllowlist: string[];
  /** Action types this turn may propose; empty means the turn proposes nothing. */
  actionTypes: ActionType[];
}

/** Build the runtime scope for a turn from a stored, enabled agent. */
export function agentTurnScope(agent: CustomAgent): AgentTurnScope {
  return {
    id: agent.id,
    name: agent.name,
    instructions: agent.instructions,
    toolAllowlist: [...agent.toolAllowlist],
    actionTypes: [...agent.actionAllowlist],
  };
}

const AGENT_ERROR_MESSAGES: Record<string, string> = {
  name_required: "نام ایجنت را وارد کنید.",
  name_too_long: "نام ایجنت بیش از حد بلند است.",
  instructions_too_long: "دستورالعمل ایجنت بیش از حد بلند است.",
  name_taken: "ایجنتی با این نام از قبل وجود دارد.",
  not_found: "ایجنت پیدا نشد.",
};

/** Persian message for an agent error code; unknown tool/action codes are explained generically. */
export function customAgentErrorMessage(code: string): string {
  if (code.startsWith("unknown_tool:")) return "ابزار انتخاب‌شده معتبر نیست.";
  if (code.startsWith("unknown_action:")) return "نوع عملیات انتخاب‌شده معتبر نیست.";
  return AGENT_ERROR_MESSAGES[code] ?? "درخواست نامعتبر است.";
}
