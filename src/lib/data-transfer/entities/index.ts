/**
 * Where every module's adapters are wired into the engine.
 *
 * One import with a side effect is a smell, so it is confined to exactly this
 * file and made explicit: `ensureAdaptersRegistered()` is idempotent and every
 * server-side entry point (the service, the worker, the tick) calls it first.
 * Nothing else imports the per-module files.
 *
 * Adding a module's entity is therefore two edits — a definition in
 * `registry.ts`, an adapter registered here — and `registry.test.ts` fails if
 * one is done without the other.
 */

import { registerAccountingAdapters } from "./accounting";
import { registerCrmAdapters } from "./crm";
import { registerInventoryAdapters } from "./inventory";
import { registerPosAdapters } from "./pos";
import { registerWebsiteAdapters } from "./website";
import { registerWorkspaceAdapters } from "./workspace";

let registered = false;

export function ensureAdaptersRegistered(): void {
  if (registered) return;
  registered = true;
  registerCrmAdapters();
  registerPosAdapters();
  registerInventoryAdapters();
  registerAccountingAdapters();
  registerWebsiteAdapters();
  registerWorkspaceAdapters();
}
