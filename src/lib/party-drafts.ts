/**
 * Party drafts — an unfinished «شخص» saved in the browser.
 *
 * Why this exists at all: the party form is long (identity, tabs for place,
 * contact and money, an avatar, a national ID that the owner has to look up in
 * another window), and the person filling it in is usually interrupted by a
 * queue at the counter. A form that loses itself on refresh is a form that gets
 * abandoned, and an abandoned party record means the sale is entered against a
 * hand-typed name that nothing else can find.
 *
 * A draft is *not* a record: it never reaches `parties`, never gets an
 * accounting code of its own, and never appears in a ledger. It is an array in
 * `localStorage`, keyed per business, capped so a busy month cannot grow it
 * without bound.
 *
 * Deliberately storage-agnostic: every function takes a `DraftStorage` rather
 * than reaching for `window`, which is what lets this be unit-tested in Node
 * (like `payment-draft.ts` and the other pure draft helpers) and lets the same
 * code later point at a `party_drafts` table if drafts ever need to survive a
 * device change. `localStorageDraftStorage()` is the only place that touches the
 * browser, and it returns `null` where there is no window — a server render or a
 * broken private-mode Safari degrades to "no drafts", never to a crash.
 */
import { deriveDisplayName, type PartyFormState, type PartyPayload, buildPartyPayload } from "./parties";

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One versioned key, so a future shape change can migrate instead of guess. */
export const PARTY_DRAFT_STORAGE_KEY = "parties:drafts:v1";

/** How many drafts one business keeps. Beyond this the oldest are dropped. */
export const MAX_PARTY_DRAFTS = 20;

export interface PartyDraft {
  id: string;
  businessId: string;
  /** A human handle for the list — «مشتری · علی رضایی», not a UUID. */
  label: string;
  savedAt: string;
  /** The party being edited, when the draft came from an existing record. */
  partyId: string | null;
  state: PartyFormState;
  /**
   * The payload the form would have sent. Stored beside the state so loading a
   * draft can show *what changed* even if the shape of the form moves under it,
   * and so a later "submit from the server" path has the structured document.
   */
  payload: PartyPayload;
}

/** The browser's own storage, or null when there is none (SSR, disabled cookies). */
export function localStorageDraftStorage(): DraftStorage | null {
  if (typeof window === "undefined") return null;
  try {
    const probe = "__parties_draft_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
      removeItem: (key) => window.localStorage.removeItem(key),
    };
  } catch {
    return null;
  }
}

function readAll(storage: DraftStorage): PartyDraft[] {
  let parsed: unknown;
  try {
    const raw = storage.getItem(PARTY_DRAFT_STORAGE_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt or hand-edited JSON: a draft list is a convenience, so the answer
    // is to start over, not to throw a red screen over the whole section.
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isPartyDraft);
}

function isPartyDraft(value: unknown): value is PartyDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<PartyDraft>;
  return (
    typeof draft.id === "string" &&
    typeof draft.savedAt === "string" &&
    typeof draft.businessId === "string" &&
    !!draft.state &&
    typeof draft.state === "object"
  );
}

function writeAll(storage: DraftStorage, drafts: PartyDraft[]): void {
  try {
    storage.setItem(PARTY_DRAFT_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Quota exceeded or storage disabled. Losing a draft must never turn into a
    // failed save of the real record, so this stays silent by design.
  }
}

/** Drafts for one business, newest first. Another business's rows are dropped on read. */
export function listPartyDrafts(storage: DraftStorage | null, businessId: string): PartyDraft[] {
  if (!storage || !businessId) return [];
  return readAll(storage)
    .filter((draft) => draft.businessId === businessId)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

/** The label a draft is listed and deleted by. */
export function partyDraftLabel(state: PartyFormState): string {
  const name = deriveDisplayName(state);
  return name ? `${name}` : "بی‌نام";
}

/**
 * Save — or update in place — a draft.
 *
 * `draftId` is what makes repeat keystrokes one row instead of twenty: the form
 * keeps the id the first save returned and hands it back every time. A new id is
 * minted only when there isn't one (a first save from a blank form, or a copy of
 * an existing party that has not been saved as a draft yet).
 */
export function savePartyDraft(
  storage: DraftStorage | null,
  input: {
    businessId: string;
    state: PartyFormState;
    draftId?: string | null;
    partyId?: string | null;
    label?: string;
    now?: () => string;
    newId?: () => string;
  },
): PartyDraft | null {
  if (!storage || !input.businessId) return null;
  const now = input.now?.() ?? new Date().toISOString();
  const id = input.draftId || input.newId?.() || `draft-${Date.now().toString(36)}`;
  const all = readAll(storage);
  const existing = all.find((draft) => draft.id === id);
  const draft: PartyDraft = {
    id,
    businessId: input.businessId,
    label: input.label ?? partyDraftLabel(input.state),
    savedAt: now,
    partyId: input.partyId ?? existing?.partyId ?? null,
    state: input.state,
    payload: buildPartyPayload(input.state),
  };
  const rest = all.filter((row) => row.id !== id);
  const next = [draft, ...rest];
  // Cap on the *business's* rows only: another tenant's drafts in the same
  // browser (a shared laptop, before per-origin tenancy) are not this cap's
  // business, and silently evicting them would be a cross-tenant side effect.
  const mine = next.filter((row) => row.businessId === input.businessId);
  const kept = new Set(mine.slice(0, MAX_PARTY_DRAFTS).map((row) => row.id));
  writeAll(
    storage,
    next.filter((row) => row.businessId !== input.businessId || kept.has(row.id)),
  );
  return draft;
}

/** The one draft with this id, or null (a stale id after another tab cleared them). */
export function loadPartyDraft(
  storage: DraftStorage | null,
  businessId: string,
  draftId: string,
): PartyDraft | null {
  if (!storage || !businessId || !draftId) return null;
  return listPartyDrafts(storage, businessId).find((draft) => draft.id === draftId) ?? null;
}

/** Remove one draft and return what is left, so the caller can re-render from one read. */
export function deletePartyDraft(
  storage: DraftStorage | null,
  businessId: string,
  draftId: string,
): PartyDraft[] {
  if (!storage || !businessId) return [];
  const others = readAll(storage).filter((draft) => !(draft.businessId === businessId && draft.id === draftId));
  writeAll(storage, others);
  return listPartyDrafts(storage, businessId);
}

/** Drop every draft of one business — «پاک‌سازی پیش‌نویس‌ها». */
export function clearPartyDrafts(storage: DraftStorage | null, businessId: string): void {
  if (!storage || !businessId) return;
  writeAll(
    storage,
    readAll(storage).filter((draft) => draft.businessId !== businessId),
  );
}

/**
 * True when the form has been touched enough that leaving would lose something.
 *
 * Compared against the defaults rather than against an empty string list, so a
 * form that only changed the tax rate from 9 to 9 counts as untouched — which is
 * what keeps the "restore draft?" prompt from firing on every open.
 */
export function partyFormHasUnsavedChanges(
  state: PartyFormState,
  defaults: PartyFormState,
): boolean {
  return JSON.stringify(buildPartyPayload(state)) !== JSON.stringify(buildPartyPayload(defaults));
}
