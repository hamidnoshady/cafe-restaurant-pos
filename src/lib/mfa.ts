export type MfaRequirement = "not_required" | "grace" | "required";

export interface AccountMfaState {
  hasPrimary: boolean;
  graceUntil: Date | null;
  role: string;
  hasGraceRecord: boolean;
}

export function enrolmentRequirement(state: AccountMfaState, now: Date = new Date()): MfaRequirement {
  if (state.hasPrimary) {
    return "not_required";
  }

  // Not enrolled. Do they require it?
  // We check if they have grace.
  if (state.hasGraceRecord) {
    if (state.graceUntil && state.graceUntil.getTime() > now.getTime()) {
      return "grace";
    }
    return "required";
  }

  return "grace";
}
