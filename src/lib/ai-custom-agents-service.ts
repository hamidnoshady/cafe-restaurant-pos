/**
 * Phase D (unified entity model) — persistence for custom Agents.
 *
 * The database half of `ai-custom-agents.ts`: CRUD over `ai_custom_agents`
 * (migration 0154), tenant-scoped through the same `query` helper every other
 * service uses (RLS enforces the isolation; the explicit `business_id = $1`
 * predicates are defence in depth and let the same code read under a superuser
 * test role). No provider call, no mutation path — an agent is configuration.
 */
import { query } from "./db";
import {
  validateCustomAgent,
  type CustomAgent,
  type CustomAgentInput,
} from "./ai-custom-agents";
import type { ActionType } from "./ai";

interface CustomAgentRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  name: string;
  instructions: string;
  tool_allowlist: string[];
  action_allowlist: string[];
  enabled: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function toAgent(row: CustomAgentRow): CustomAgent {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    instructions: row.instructions,
    toolAllowlist: row.tool_allowlist ?? [],
    actionAllowlist: (row.action_allowlist ?? []) as ActionType[],
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const COLUMNS =
  "id, business_id, name, instructions, tool_allowlist, action_allowlist, enabled, created_by, created_at, updated_at";

export type CustomAgentResult =
  | { ok: true; agent: CustomAgent }
  | { ok: false; errors: string[] };

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

export async function listCustomAgents(businessId: string): Promise<CustomAgent[]> {
  const { rows } = await query<CustomAgentRow>(
    `SELECT ${COLUMNS} FROM ai_custom_agents WHERE business_id = $1 ORDER BY created_at DESC`,
    [businessId],
  );
  return rows.map(toAgent);
}

export async function getCustomAgent(
  businessId: string,
  id: string,
): Promise<CustomAgent | null> {
  const { rows } = await query<CustomAgentRow>(
    `SELECT ${COLUMNS} FROM ai_custom_agents WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ? toAgent(rows[0]) : null;
}

export async function createCustomAgent(
  businessId: string,
  input: CustomAgentInput,
  createdBy: string | null,
): Promise<CustomAgentResult> {
  const validation = validateCustomAgent(input);
  if (!validation.ok) return validation;
  const value = validation.value;

  try {
    const { rows } = await query<CustomAgentRow>(
      `INSERT INTO ai_custom_agents
         (business_id, name, instructions, tool_allowlist, action_allowlist, enabled, created_by)
       VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7)
       RETURNING ${COLUMNS}`,
      [
        businessId,
        value.name,
        value.instructions,
        value.toolAllowlist,
        value.actionAllowlist,
        value.enabled,
        createdBy,
      ],
    );
    return { ok: true, agent: toAgent(rows[0]) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: ["name_taken"] };
    throw error;
  }
}

export async function updateCustomAgent(
  businessId: string,
  id: string,
  input: CustomAgentInput,
): Promise<CustomAgentResult> {
  const validation = validateCustomAgent(input);
  if (!validation.ok) return validation;
  const value = validation.value;

  try {
    const { rows } = await query<CustomAgentRow>(
      `UPDATE ai_custom_agents
          SET name = $3,
              instructions = $4,
              tool_allowlist = $5::text[],
              action_allowlist = $6::text[],
              enabled = $7,
              updated_at = now()
        WHERE business_id = $1 AND id = $2
        RETURNING ${COLUMNS}`,
      [
        businessId,
        id,
        value.name,
        value.instructions,
        value.toolAllowlist,
        value.actionAllowlist,
        value.enabled,
      ],
    );
    if (!rows[0]) return { ok: false, errors: ["not_found"] };
    return { ok: true, agent: toAgent(rows[0]) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: ["name_taken"] };
    throw error;
  }
}

export async function deleteCustomAgent(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM ai_custom_agents WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return (rowCount ?? 0) > 0;
}
