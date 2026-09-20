/**
 * Phase 35 Wave 3 — shared constants and pure functions for AI projects.
 *
 * This file is framework-free (no `db`, no `next`) so client components can
 * import it directly. The DB-touching half lives in `ai-projects.ts`.
 */

/** The character limit for project instructions + note titles combined. */
export const PROJECT_INSTRUCTION_CHAR_LIMIT = 4000;

/**
 * Phase F — project memory. A memory is a short, standing FACT the assistant
 * carries for this project, not a document: the length cap keeps the prompt
 * context bounded, and the entry cap keeps a runaway "remember this too" loop
 * from crowding out the actual conversation. Both are enforced server-side.
 */
export const PROJECT_MEMORY_CHAR_LIMIT = 500;
export const PROJECT_MEMORY_MAX_ENTRIES = 50;

/**
 * Phase F pt.3 — project tasks. A task title is a single line of work, so it is
 * capped tighter than a memory fact; the open-task cap keeps the prompt context
 * (which lists open tasks) bounded and a runaway "add a task too" loop in check.
 * Both are enforced server-side.
 */
export const PROJECT_TASK_CHAR_LIMIT = 200;
export const PROJECT_TASK_MAX_OPEN = 50;

/**
 * Pure: computes the total character weight of a project's instructions and
 * note titles. The limit is enforced server-side before save, and the client
 * shows the remaining budget.
 */
export function instructionWeight(instructions: string, noteTitles: string[]): number {
  return instructions.length + noteTitles.reduce((sum, title) => sum + title.length, 0);
}

/**
 * Pure: whether the given weight exceeds the limit.
 */
export function isOverInstructionLimit(weight: number): boolean {
  return weight > PROJECT_INSTRUCTION_CHAR_LIMIT;
}

/**
 * Pure: clamps instructions to the limit, respecting existing note titles.
 */
export function clampInstructions(instructions: string, noteTitles: string[]): string {
  const titlesWeight = noteTitles.reduce((sum, title) => sum + title.length, 0);
  const budget = PROJECT_INSTRUCTION_CHAR_LIMIT - titlesWeight;
  if (budget <= 0) return "";
  if (instructions.length <= budget) return instructions;
  return instructions.slice(0, budget);
}
