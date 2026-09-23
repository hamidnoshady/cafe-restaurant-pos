import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import { MediaAiError, runMediaEnhance } from "@/lib/ai-media-service";
import { MEDIA_ENHANCE_FEATURE_KEY } from "@/lib/media";
import {
  getMediaConfig,
  isMediaStorageReady,
  readMediaObject,
  storeMediaAsset,
} from "@/lib/media-service";
import { chargeFeatureUse, WalletInsufficientFundsError } from "@/lib/wallet-service";

/**
 * The optional AI product-image refine (migration 0149): photo in, the
 * standard website product shot out — pure white background, subject
 * centered, consistent margins. The result is a NEW 'enhanced' asset row
 * pointing back at its original, so the source photo is never overwritten
 * and the operator chooses which one an item or the website uses.
 *
 * Priced by the console (`platform_media_config.enhance_price_rial`) and
 * debited from the business wallet BEFORE the provider call; a failed call
 * refunds by simply not having charged — the debit happens only after the
 * enhanced bytes are in hand, so the business never pays for a failure.
 */
export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const mediaConfig = await getMediaConfig();
  if (!isMediaStorageReady(mediaConfig)) {
    return NextResponse.json({ error: "storage_not_configured" }, { status: 503 });
  }

  const stored = await readMediaObject(session.businessId, id, mediaConfig).catch(() => null);
  if (!stored) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  if (stored.asset.kind !== "image" || stored.asset.mimeType === "image/svg+xml") {
    return NextResponse.json(
      { error: "not_an_image", message: "بهینه‌سازی فقط برای تصاویر در دسترس است." },
      { status: 400 },
    );
  }

  const config = await resolveAiConfigFor(session.businessId, null, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, { businessId: session.businessId, locationId: null, surface: "media_enhance" });
    return NextResponse.json(
      { error: "ai_unavailable", reason, message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  // The provider call first: the wallet is debited only for a result in hand.
  let enhanced: Awaited<ReturnType<typeof runMediaEnhance>>;
  try {
    enhanced = await runMediaEnhance({
      config,
      model: mediaConfig.enhanceModel,
      imageBytes: stored.bytes,
      mimeType: stored.asset.mimeType,
      fileName: stored.asset.fileName,
    });
  } catch (err) {
    if (err instanceof MediaAiError) {
      const status =
        err.code === "ai_auth" ? 502
        : err.code === "ai_timeout" || err.code === "ai_network" ? 504
        : err.code === "enhance_unsupported" ? 501
        : 422;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }

  if (mediaConfig.enhancePriceRial > 0) {
    try {
      await chargeFeatureUse({
        businessId: session.businessId,
        featureKey: MEDIA_ENHANCE_FEATURE_KEY,
        priceRial: mediaConfig.enhancePriceRial,
        note: `بهینه‌سازی تصویر محصول «${stored.asset.fileName}»`,
        userId: session.sub,
        metadata: { assetId: id, metered: true },
      });
    } catch (err) {
      if (err instanceof WalletInsufficientFundsError) {
        return NextResponse.json(
          { error: "insufficient_funds", message: "موجودی کیف پول برای بهینه‌سازی تصویر کافی نیست." },
          { status: 402 },
        );
      }
      throw err;
    }
  }

  const baseName = stored.asset.fileName.replace(/\.[a-z0-9]+$/i, "");
  const asset = await storeMediaAsset({
    businessId: session.businessId,
    userId: session.sub,
    config: mediaConfig,
    kind: "image",
    fileName: `${baseName}-enhanced.png`,
    mimeType: "image/png",
    bytes: enhanced.bytes,
    sha256: createHash("sha256").update(enhanced.bytes).digest("hex"),
    folderId: stored.asset.folderId,
    variant: "enhanced",
    sourceAssetId: stored.asset.id,
  });

  return NextResponse.json({ ok: true, asset }, { status: 201 });
});
