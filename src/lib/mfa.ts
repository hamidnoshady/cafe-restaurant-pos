export type MfaRequirement = "not_required" | "grace" | "required";

export interface AccountMfaState {
  hasPrimary: boolean;
  graceUntil: Date | null;
  role: string;
}

export function enrolmentRequirement(state: AccountMfaState, now: Date = new Date()): MfaRequirement {
  // If they have a primary MFA enrolled, it's not strictly "required to enrol",
  // they've already enrolled. But wait, if they need to enrol:
  // "enrolmentRequirement(account, now) → not_required | grace | required"
  
  // Who needs it? "every platform_admins row... and every business account with full privileges (owner, plus anyone requirePermission resolves to a full permission set... A business may opt to extend the requirement to manager; off by default.)"
  
  if (state.hasPrimary) {
    return "not_required";
  }

  // Not enrolled. Do they require it?
  // We check if they have grace.
  if (state.graceUntil) {
    if (state.graceUntil.getTime() > now.getTime()) {
      return "grace";
    }
    return "required";
  }

  // If no graceUntil is set yet, it means they haven't logged in since deploy.
  // Wait, the spec says "stamped at the first login after deploy". So if it's not set, they are in grace?
  // No, if they login and it's null, we stamp it then. So at this point, if it's null, they need it stamped. But for the purpose of the requirement right now before stamping:
  return "required";
}
