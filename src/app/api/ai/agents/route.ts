import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { getAiAgentsOverview, getAiAgentsTodayTasks, setAiAgentEnabled } from "@/lib/ai-proactive-service";
import { isAiAgentKey } from "@/lib/ai-agents";
import { requireManager } from "@/lib/setup-state";

/**
 * Manager-controlled per-agent toggles (Wave 3, issue #143) — refines
 * ai/proactive's master opt-in. `todayTasks` (Wave 4, issue #144) is the
 * hub's "کارهای خودکار امروز" list, computed alongside the same settings.
 */
export const GET = withTenantScope(async () => {
  const guard = await requireManager();
  if (guard.error) return guard.error;
  const [agents, todayTasks] = await Promise.all([
    getAiAgentsOverview(guard.session.businessId),
    getAiAgentsTodayTasks(guard.session.businessId),
  ]);
  return NextResponse.json({ agents, todayTasks });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const guard = await requireManager();
  if (guard.error) return guard.error;
  let body: { agentKey?: unknown; enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isAiAgentKey(body.agentKey)) {
    return NextResponse.json({ error: "invalid_agent_key" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_agent_enabled" }, { status: 400 });
  }
  await setAiAgentEnabled(guard.session.businessId, body.agentKey, body.enabled);
  const [agents, todayTasks] = await Promise.all([
    getAiAgentsOverview(guard.session.businessId),
    getAiAgentsTodayTasks(guard.session.businessId),
  ]);
  return NextResponse.json({ agents, todayTasks });
});
