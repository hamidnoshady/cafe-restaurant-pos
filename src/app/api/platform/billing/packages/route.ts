import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { listCreditPackages, saveCreditPackage } from "@/lib/wallet-service";

/** All credit packages (active and inactive) for the plan/billing console. */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ packages: await listCreditPackages(false) });
});

/** Create or update a credit package. */
export const POST = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("billing.manage");
  if (guard.error) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  const priceRial = Math.floor(Number(body.priceRial ?? 0));
  const creditRial = Math.floor(Number(body.creditRial ?? 0));
  if (!name || priceRial <= 0 || creditRial <= 0) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const pkg = await saveCreditPackage({
    id: typeof body.id === "string" && body.id ? body.id : undefined,
    name,
    priceRial,
    creditRial,
    isActive: body.isActive !== false,
    sortOrder: Math.floor(Number(body.sortOrder ?? 0)) || 0,
  });
  return NextResponse.json({ package: pkg });
});
