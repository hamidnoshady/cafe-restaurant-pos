"use client";

/**
 * A customer's full A/R activity (invoices + receipts) with a running balance
 * — «what makes up this customer's number».
 *
 * The panel itself lives once in `subledger-section.tsx`, shared with the A/P
 * mirror; this wrapper is the A/R side of it under the prop shape the
 * directory (`parties-section.tsx`) opens it with — an A/R statement is
 * addressed by the *party* id, which is the id the directory already holds.
 */
import { RECEIVABLES_SIDE } from "./ar-section";
import { SubledgerStatementPanel } from "./subledger-section";

export function ArStatementPanel({
  customerId,
  customerName,
  onClose,
}: {
  customerId: string;
  customerName: string;
  onClose: () => void;
}) {
  return (
    <SubledgerStatementPanel
      side={RECEIVABLES_SIDE}
      id={customerId}
      name={customerName}
      partyId={customerId}
      onClose={onClose}
    />
  );
}
