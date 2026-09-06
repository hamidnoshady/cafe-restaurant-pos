"use client";

/**
 * CRM → مشتریان.
 *
 * This used to be the customer screen: its own search box, its own add/edit form,
 * its own inactive flag, its own `active` checkbox on save. All of that now lives
 * in `../parties/parties-section.tsx`, shared with the store's suppliers, the
 * team's personnel and the ledger's party file — the four copies of "a person we
 * owe or who owes us" that a counterparty could disagree about.
 *
 * What is left here is the CRM's own opinion about that shared list: which scope
 * it shows, and the URL conventions its other sections and the AI use to hand a
 * customer over — `?customer=<id>` opens one party's file (the phone lookup the AI
 * answers with), `?new=1` opens the add form (the overview's quick action). Both
 * keep working after the rename; a saved link to a customer is not a thing to
 * break.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { partyScopeFor } from "@/lib/parties-scopes";
import { PartiesSection } from "../parties/parties-section";

export function DirectorySection({ role }: { role: string }) {
  const searchParams = useSearchParams();
  const [editPartyId, setEditPartyId] = useState<string | null>(searchParams.get("customer"));
  const openNewOnMount = searchParams.get("new") === "1";

  /**
   * Follow a `?customer=` link that arrives while the screen is already mounted
   * (a chat answer or a dashboard card pushing a new one), and drop the parameter
   * once the form has taken it, so a refresh does not reopen a form the person
   * closed.
   */
  const customerParam = searchParams.get("customer");
  useEffect(() => {
    if (customerParam) setEditPartyId(customerParam);
  }, [customerParam]);
  return (
    <PartiesSection
      scope={partyScopeFor("crm")}
      role={role}
      editPartyId={editPartyId}
      openNewOnMount={openNewOnMount}
    />
  );
}
