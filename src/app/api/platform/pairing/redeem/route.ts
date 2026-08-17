import { NextRequest } from "next/server";
import { handlePairingRedeem } from "@/lib/pairing-redeem";

/**
 * The original desktop-pairing redemption URL, kept because every desktop
 * build already in the field points at it (and /api/setup/pair falls back to
 * it when the cloud server is older than /api/pairing/redeem).
 *
 * It lives under /api/platform because the *issuing* side used to be the
 * platform console exclusively, not because it needs a platform session — the
 * caller is a freshly-installed desktop app with no session in either realm.
 * That prefix is also why the host-neutral twin exists: middleware moves
 * /api/platform to the console's own host, which a business origin's pairing
 * request should not have to follow.
 */
export async function POST(request: NextRequest) {
  return handlePairingRedeem(request);
}
