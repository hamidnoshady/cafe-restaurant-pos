import { NextRequest, NextResponse } from "next/server";
import { getPlatformAiConfig, isPlatformAiConfigured } from "@/lib/ai-config";
import {
  AiInsufficientCreditError,
  cancelAiTurnReservation,
  reserveAiTurn,
  settleAiTurn,
  type AiTurnReservation,
} from "@/lib/ai-billing-service";
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

  const config = await getPlatformAiConfig();
  if (!isPlatformAiConfigured(config)) {
    return NextResponse.json(
      { error: "ai_unavailable", message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  let reservation: AiTurnReservation;
  try {
    reservation = await reserveAiTurn({
      businessId: session.businessId,
      reservedRial: config.maxTurnRial,
      userId: session.sub,
      metadata: { kind: "invoice_ocr", locationId: location.id },
    });
  } catch (err) {
    if (err instanceof AiInsufficientCreditError) {
      return NextResponse.json(
        { error: "ai_credit_required", message: "اعتبار هوش مصنوعی کافی نیست." },
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
      reservation,
      usage: result.usage,
      inputTokenRialPerMillion: config.inputTokenRialPerMillion,
      outputTokenRialPerMillion: config.outputTokenRialPerMillion,
    });

    return NextResponse.json({
      ok: true,
      extraction: result.extraction,
      lines: result.lines,
      validation: result.validation,
      supplierId: result.supplierId,
      supplierName: result.supplierName,
      usage: result.usage,
      costRial: settlement.chargedRial + settlement.overageRial,
    });
  } catch (err) {
    await cancelAiTurnReservation({
      businessId: session.businessId,
      reservation,
      reason: err instanceof InvoiceOcrError ? err.code : "invoice_ocr_failed",
    }).catch(() => {
      // Best-effort refund; the reserved row is still the source of truth.
    });

    if (err instanceof InvoiceOcrError) {
      const status =
        err.code === "ai_auth" ? 502 : err.code === "ai_timeout" || err.code === "ai_network" ? 504 : 422;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }
});
