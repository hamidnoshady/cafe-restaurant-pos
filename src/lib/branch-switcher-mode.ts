/**
 * Which of its three shapes the branch switcher takes, as a pure decision.
 *
 * This lived inline in branch-switcher.tsx as a pair of nested conditions, and
 * that is how it regressed: the control was rewritten to render for a
 * single-branch member "so they can see where they are", which sounded right
 * and put a permanent, unclickable chip in the header of every single-branch
 * business on the platform — the large majority of them. The bug was not in
 * the JSX but in the rule, so the rule is now a function with a name and a
 * test, and the component just renders what it returns.
 *
 * The two inputs are not interchangeable, which is the subtlety the original
 * code missed. `canSwitch` says whether this *member* may move between
 * branches; `businessLocationCount` says how many branches the *business* has,
 * before the member's access narrows anything. A cashier pinned to one branch
 * of a five-branch business and a lone owner of a one-branch business both
 * have canSwitch === false and exactly one reachable location, and they want
 * opposite things:
 *
 *   - the pinned cashier can be working North while everyone talks about Main,
 *     so they need to be told, always, which branch they are in;
 *   - the single-branch owner has no such question, and a chip answering it
 *     forever is clutter.
 */
export type BranchSwitcherMode = "menu" | "label" | "hidden";

export interface BranchSwitcherState {
  /** Whether this member may switch branches at all. */
  canSwitch: boolean;
  /**
   * Branches the business has, before access filtering. Optional because an
   * older/partial response may omit it; callers fall back to the reachable
   * count, which is correct whenever the member can see everything.
   */
  businessLocationCount?: number;
  /** How many branches this member can actually reach. */
  accessibleCount: number;
}

export function branchSwitcherMode(state: BranchSwitcherState): BranchSwitcherMode {
  if (state.canSwitch) return "menu";
  // Fall back to the reachable count when the business-wide count is absent:
  // it is the same number for anyone who isn't pinned, so the worst case is
  // that a pinned member briefly loses the label, never that a single-branch
  // business gains a chip.
  const businessBranches = state.businessLocationCount ?? state.accessibleCount;
  return businessBranches >= 2 ? "label" : "hidden";
}
