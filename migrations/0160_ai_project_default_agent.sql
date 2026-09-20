-- Phase F (Projects as workspaces), Part 5 — a project's default agent.
--
-- Parts 1–4 gave a project everything it needs to INFORM a turn: a standing
-- instruction, notes, memory, open tasks, and its own conversation list. All of
-- that shapes what the assistant KNOWS. It does not change what the assistant
-- may DO — every project turn still runs as the full dashboard assistant.
--
-- A workspace often wants the opposite: "inside this campaign, always work as my
-- Marketing agent — its tone, and only the actions it is allowed to propose".
-- Phase D already built that noun (ai_custom_agents, 0154): a business-defined
-- agent that NARROWS a turn's read tools and proposable actions and adds a
-- per-agent instruction. Until now an agent could only be chosen per-request
-- (chat's `agentId`). This column lets a project PIN one, so every conversation
-- opened in the project runs as that agent without the caller re-selecting it.
--
-- Safety is inherited, not re-invented: pinning an agent can only ever NARROW a
-- turn (an agent's allowlists are a subset of the catalogue, validated in
-- ai-custom-agents.ts). A request-level `agentId` still wins over the project
-- default, and a project-scoped turn that runs as an agent does NOT also gain
-- the project-scoped write actions — an agent's action list is its own (the
-- same rule the chat route already applies: `projectScoped` is set only when
-- there is no agent). So this never widens anyone's authority.
--
-- ON DELETE SET NULL: deleting or disabling the agent must not orphan or break
-- the project — the project simply falls back to the full assistant. Additive:
-- the column is nullable with no default, so every existing project keeps
-- behaving exactly as before (no pinned agent).

ALTER TABLE ai_projects
    ADD COLUMN default_agent_id uuid NULL
        REFERENCES ai_custom_agents(id) ON DELETE SET NULL;
