import { NextRequest } from "next/server";
import { handlePairingRedeem } from "@/lib/pairing-redeem";

/**
 * Host-neutral desktop pairing redemption — see src/lib/pairing-redeem.ts for
 * why this exists alongside /api/platform/pairing/redeem.
 *
 * Public and session-less: the one-time code in the body is the credential.
 * Listed in middleware's PUBLIC_PATHS and in its per-IP auth rate-limit bucket
 * alongside every other credential exchange.
 */
export async function POST(request: NextRequest) {
  return handlePairingRedeem(request);
}
