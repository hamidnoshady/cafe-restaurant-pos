/**
 * Phase 35 Wave 3 — AI projects: target folders that group conversations,
 * notes and a standing instruction.
 *
 * A project is a "folder with purpose": threads live inside it, notes sit
 * beside them, and a static instruction shapes the assistant's behavior in
 * those threads. Status/owner/budget and cost-center dimension are Phase 37;
 * building them now would produce empty columns.
 *
 * Framework-free except for `query` (the same thin wrapper every service
 * uses). The UI and API routes import from here; this module never imports
 * from `next` or any component.
 *
 * Pure constants and functions are in `ai-projects-shared.ts` so client
 * components can import them without pulling in `db.ts`.
 */
import { query } from "./db";
import {
  PROJECT_INSTRUCTION_CHAR_LIMIT,
  instructionWeight,
  isOverInstructionLimit,
  clampInstructions,
} from "./ai-projects-shared";
export {
  PROJECT_INSTRUCTION_CHAR_LIMIT,
  instructionWeight,
  isOverInstructionLimit,
  clampInstructions,
} from "./ai-projects-shared";

export interface AiProject {
  id: string;
  name: string;
  instructions: string;
  createdBy: string;
  archivedAt: string | null;
  createdAt: string;
}

export interface AiProjectNote {
  id: string;
  projectId: string;
  title: string;
  content: string;
  createdBy: string;
  createdAt: string;
}

export interface AiProjectWithNoteCount extends AiProject {
  noteCount: number;
  conversationCount: number;
}

interface Owner {
  businessId: string;
  actorUserId: string;
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

export async function createProject(
  owner: Owner,
  input: { name: string; instructions?: string },
): Promise<AiProject> {
  const name = input.name.trim();
  if (!name) throw new Error("Project name is required");
  const instructions = input.instructions?.trim() ?? "";
  if (isOverInstructionLimit(instructionWeight(instructions, []))) {
    throw new Error("Instructions exceed the character limit");
  }
  const { rows } = await query<{
    id: string;
    name: string;
    instructions: string;
    created_by: string;
    archived_at: string | null;
    created_at: string;
  }>(
    `INSERT INTO ai_projects (business_id, name, instructions, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, instructions, created_by, archived_at, created_at`,
    [owner.businessId, name, instructions, owner.actorUserId],
  );
  return {
    id: rows[0].id,
    name: rows[0].name,
    instructions: rows[0].instructions,
    createdBy: rows[0].created_by,
    archivedAt: rows[0].archived_at,
    createdAt: rows[0].created_at,
  };
}

export async function listProjects(
  owner: Owner,
  options: { includeArchived?: boolean } = {},
): Promise<AiProjectWithNoteCount[]> {
  const archivedClause = options.includeArchived ? "" : "AND p.archived_at IS NULL";
  const { rows } = await query<{
    id: string;
    name: string;
    instructions: string;
    created_by: string;
    archived_at: string | null;
    created_at: string;
    note_count: string;
    conversation_count: string;
  }>(
    `SELECT p.id, p.name, p.instructions, p.created_by, p.archived_at, p.created_at,
            (SELECT count(*) FROM ai_project_notes n WHERE n.project_id = p.id) AS note_count,
            (SELECT count(*) FROM ai_conversations c WHERE c.project_id = p.id) AS conversation_count
       FROM ai_projects p
      WHERE p.business_id = $1 ${archivedClause}
      ORDER BY p.created_at DESC`,
    [owner.businessId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    createdBy: row.created_by,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    noteCount: Number(row.note_count),
    conversationCount: Number(row.conversation_count),
  }));
}

export async function getProject(
  owner: Owner & { projectId: string },
): Promise<AiProject | null> {
  const { rows } = await query<{
    id: string;
    name: string;
    instructions: string;
    created_by: string;
    archived_at: string | null;
    created_at: string;
  }>(
    `SELECT id, name, instructions, created_by, archived_at, created_at
       FROM ai_projects
      WHERE id = $1 AND business_id = $2`,
    [owner.projectId, owner.businessId],
  );
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    name: rows[0].name,
    instructions: rows[0].instructions,
    createdBy: rows[0].created_by,
    archivedAt: rows[0].archived_at,
    createdAt: rows[0].created_at,
  };
}

export async function updateProject(
  owner: Owner & { projectId: string },
  input: { name?: string; instructions?: string },
): Promise<AiProject | null> {
  const existing = await getProject(owner);
  if (!existing) return null;

  const name = input.name?.trim() ?? existing.name;
  if (!name) throw new Error("Project name is required");
  const instructions = input.instructions?.trim() ?? existing.instructions;

  // Check instruction limit against existing note titles
  const { rows: noteRows } = await query<{ title: string }>(
    `SELECT title FROM ai_project_notes WHERE project_id = $1`,
    [owner.projectId],
  );
  const noteTitles = noteRows.map((r) => r.title);
  if (isOverInstructionLimit(instructionWeight(instructions, noteTitles))) {
    throw new Error("Instructions exceed the character limit");
  }

  const { rows } = await query<{
    id: string;
    name: string;
    instructions: string;
    created_by: string;
    archived_at: string | null;
    created_at: string;
  }>(
    `UPDATE ai_projects
        SET name = $3, instructions = $4
      WHERE id = $1 AND business_id = $2
      RETURNING id, name, instructions, created_by, archived_at, created_at`,
    [owner.projectId, owner.businessId, name, instructions],
  );
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    name: rows[0].name,
    instructions: rows[0].instructions,
    createdBy: rows[0].created_by,
    archivedAt: rows[0].archived_at,
    createdAt: rows[0].created_at,
  };
}

export async function archiveProject(
  owner: Owner & { projectId: string },
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE ai_projects SET archived_at = now()
      WHERE id = $1 AND business_id = $2 AND archived_at IS NULL`,
    [owner.projectId, owner.businessId],
  );
  return (rowCount ?? 0) > 0;
}

export async function unarchiveProject(
  owner: Owner & { projectId: string },
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE ai_projects SET archived_at = NULL
      WHERE id = $1 AND business_id = $2 AND archived_at IS NOT NULL`,
    [owner.projectId, owner.businessId],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function addNote(
  owner: Owner & { projectId: string },
  input: { title: string; content: string },
): Promise<AiProjectNote> {
  const title = input.title.trim();
  const content = input.content.trim();

  // Check instruction limit
  const project = await getProject(owner);
  if (!project) throw new Error("Project not found");

  const { rows: existingNotes } = await query<{ title: string }>(
    `SELECT title FROM ai_project_notes WHERE project_id = $1`,
    [owner.projectId],
  );
  const existingTitles = existingNotes.map((r) => r.title);
  const newTitles = [...existingTitles, title];
  if (isOverInstructionLimit(instructionWeight(project.instructions, newTitles))) {
    throw new Error("Adding this note would exceed the instruction character limit");
  }

  const { rows } = await query<{
    id: string;
    project_id: string;
    title: string;
    content: string;
    created_by: string;
    created_at: string;
  }>(
    `INSERT INTO ai_project_notes (project_id, title, content, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, title, content, created_by, created_at`,
    [owner.projectId, title, content, owner.actorUserId],
  );
  return {
    id: rows[0].id,
    projectId: rows[0].project_id,
    title: rows[0].title,
    content: rows[0].content,
    createdBy: rows[0].created_by,
    createdAt: rows[0].created_at,
  };
}

export async function listNotes(
  owner: Owner & { projectId: string },
): Promise<AiProjectNote[]> {
  const { rows } = await query<{
    id: string;
    project_id: string;
    title: string;
    content: string;
    created_by: string;
    created_at: string;
  }>(
    `SELECT id, project_id, title, content, created_by, created_at
       FROM ai_project_notes
      WHERE project_id = $1
      ORDER BY created_at ASC`,
    [owner.projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

export async function deleteNote(
  owner: Owner & { projectId: string; noteId: string },
): Promise<boolean> {
  // Verify the note belongs to a project this business owns
  const { rowCount } = await query(
    `DELETE FROM ai_project_notes n
      USING ai_projects p
      WHERE n.id = $1 AND n.project_id = $2
        AND p.id = n.project_id AND p.business_id = $3`,
    [owner.noteId, owner.projectId, owner.businessId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Builds the project context to inject into the system prompt for a
 * conversation that belongs to this project. Returns empty string if the
 * project has no instructions and no notes.
 */
export function buildProjectPromptContext(
  instructions: string,
  notes: AiProjectNote[],
): string {
  const parts: string[] = [];
  if (instructions.trim()) {
    parts.push(`دستور پروژه:\n${instructions.trim()}`);
  }
  if (notes.length > 0) {
    const noteList = notes.map((n) => `- ${n.title}`).join("\n");
    parts.push(`یادداشت‌های پروژه:\n${noteList}`);
  }
  return parts.join("\n\n");
}
