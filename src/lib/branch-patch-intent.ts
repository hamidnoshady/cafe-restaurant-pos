/**
 * What a PATCH /api/branches/[id] body is actually asking for.
 *
 * Two kinds of change reach this endpoint and they are deliberately not
 * accepted together: editing fields (name/address/phone/timezone/colour) and
 * flipping is_active. They have separate rules and separate failure modes —
 * deactivation can be refused for open orders long after a rename has already
 * been committed — and an earlier handler ran them in sequence with no
 * transaction around the pair, so a body carrying both could rename the
 * branch, fail to deactivate it, and return one error that made the
 * already-saved rename look rejected.
 *
 * Pulled out of the route handler so the classification can be tested without
 * standing up a request, a session and a database: the interesting cases here
 * are all shapes of JSON, and every one of them used to require an
 * integration test to reach.
 */
export type BranchPatchIntent =
  | { kind: "activate" }
  | { kind: "deactivate" }
  | { kind: "edit" }
  /** Malformed: both kinds at once, or isActive that isn't a boolean. */
  | { kind: "bad_request" }
  /** Well-formed but empty — asks for nothing. */
  | { kind: "nothing_to_change" };

export interface BranchPatchBody {
  name?: unknown;
  address?: unknown;
  phone?: unknown;
  timezone?: unknown;
  color?: unknown;
  isActive?: unknown;
}

/** Field keys that count as an edit. Kept in one place so adding a field to
 *  the endpoint cannot silently bypass the "not both at once" rule. */
export const BRANCH_EDIT_FIELDS = ["name", "address", "phone", "timezone", "color"] as const;

export function branchPatchIntent(body: BranchPatchBody): BranchPatchIntent {
  // `undefined` means absent; `null` is a real value (clearing an address),
  // which is why this tests for presence rather than truthiness.
  const editsFields = BRANCH_EDIT_FIELDS.some((field) => body[field] !== undefined);
  const togglesActive = body.isActive !== undefined;

  if (togglesActive && typeof body.isActive !== "boolean") return { kind: "bad_request" };
  if (togglesActive && editsFields) return { kind: "bad_request" };
  if (!togglesActive && !editsFields) return { kind: "nothing_to_change" };
  if (togglesActive) return { kind: body.isActive === true ? "activate" : "deactivate" };
  return { kind: "edit" };
}
