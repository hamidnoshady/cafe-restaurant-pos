import { NextRequest, NextResponse } from "next/server";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import {
  AiWalletInsufficientError,
  gateAiTurn,
  newAiRequestId,
  settleAiTurn,
} from "@/lib/ai-wallet-billing";
import { parseReceiptImageDataUrl } from "@/lib/ai-receipt";
import { InvoiceOcrError, runInvoiceOcr } from "@/lib/ai-invoice-ocr-service";
import { requireManager, resolveActiveLocation } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

/**
 * Metered supplier-invoice OCR.
 *
 * Owner/manager only (same scope as purchases). The image is a one-shot data
 * URL — never persisted. Credits are reserved up front at maxTurnRial and
 * settled against the provider's actual token usage, matching /api/ai/chat.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requireManager();
  if (guard.error) return guard.error;
  const session = guard.session;

  let body: { image?: unknown; dataUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const rawImage = body.image ?? body.dataUrl;
  const dataUrl =
    typeof rawImage === "string"
      ? rawImage
      : rawImage && typeof rawImage === "object" && typeof (rawImage as { dataUrl?: unknown }).dataUrl === "string"
        ? ((rawImage as { dataUrl: string }).dataUrl)
        : null;

  const parsed = parseReceiptImageDataUrl(dataUrl);
  if (!parsed) {
    return NextResponse.json(
      { error: "attachment_invalid", message: "فرمت یا حجم تصویر فاکتور پشتیبانی نمی‌شود." },
      { status: 400 },
    );
  }

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({ error: "no_location", message: "شعبه‌ای ثبت نشده است." }, { status: 409 });
  }

  const config = await resolveAiConfigFor(session.businessId, location.id, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, { businessId: session.businessId, locationId: location.id, surface: "invoice_ocr" });
    return NextResponse.json(
      { error: "ai_unavailable", reason, message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  const requestId = newAiRequestId();
  try {
    await gateAiTurn(session.businessId, config);
  } catch (err) {
    if (err instanceof AiWalletInsufficientError) {
      return NextResponse.json(
        { error: "ai_credit_required", message: "اعتبار هوش مصنوعی کافی نیست. کیف پول کسب‌وکار را شارژ کنید." },
        { status: 402 },
      );
    }
    throw err;
  }

  try {
    const result = await runInvoiceOcr({
      config,
      locationId: location.id,
      dataUrl: parsed.dataUrl,
    });

    const settlement = await settleAiTurn({
      businessId: session.businessId,
      requestId,
      config,
      usage: result.usage,
      costUsd: result.costUsd,
      attribution: {
        requestType: "ocr",
        model: config.model,
        locationId: location.id,
        userId: session.sub,
        metadata: { kind: "invoice_ocr" },
      },
    });

    return NextResponse.json({
      ok: true,
      extraction: result.extraction,
      lines: result.lines,
      validation: result.validation,
      supplierId: result.supplierId,
      supplierName: result.supplierName,
      usage: result.usage,
      costRial: settlement.chargedRial,
    });
  } catch (err) {
    // Phase B — no reservation to refund; a failed turn settles nothing.
    if (err instanceof InvoiceOcrError) {
      const status =
        err.code === "ai_auth" ? 502 : err.code === "ai_timeout" || err.code === "ai_network" ? 504 : 422;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }
});
