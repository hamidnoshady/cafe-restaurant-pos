import { AcceptInvite } from "./accept-invite";

/**
 * Phase 13 — the page an invitation link lands on.
 *
 * Public: the invitee has no session and no membership of the inviting
 * business yet, so the token in the URL is the credential. It's on the
 * middleware's public list for the same reason /login is.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AcceptInvite token={token} />;
}
