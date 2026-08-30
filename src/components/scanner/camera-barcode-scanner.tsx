"use client";

/**
 * In-app camera barcode / QR scanner for inventory and retail flows.
 *
 * Prefer the browser's native `BarcodeDetector` (Chrome/Edge/Android, newer
 * Safari) — no dependency, works offline once the page is loaded. When the
 * API is missing the operator can still capture a still frame and we retry
 * detection on that image, or fall back to typing the code. Handheld wedge
 * scanners continue to work through the ordinary text field this dialog
 * sits next to; this only covers the phone-camera case.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraIcon, SwitchCameraIcon, XIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { normalizeBarcode } from "@/lib/barcode";

type BarcodeDetectorInstance = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string; format?: string }>>;
};

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance;

const PREFERRED_FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "codabar",
  "qr_code",
  "data_matrix",
  "itf",
];

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

async function supportedFormats(ctor: BarcodeDetectorCtor): Promise<string[]> {
  const getSupported = (
    ctor as unknown as { getSupportedFormats?: () => Promise<string[]> }
  ).getSupportedFormats;
  if (typeof getSupported !== "function") return PREFERRED_FORMATS;
  try {
    const list = await getSupported.call(ctor);
    const preferred = PREFERRED_FORMATS.filter((f) => list.includes(f));
    return preferred.length > 0 ? preferred : list;
  } catch {
    return PREFERRED_FORMATS;
  }
}

export function CameraBarcodeScanner({
  open,
  onClose,
  onScan,
  title = "اسکن بارکد / QR",
  description = "بارکد یا QR کالا را در کادر قرار دهید تا به‌صورت خودکار خوانده شود.",
}: {
  open: boolean;
  onClose: () => void;
  /** Fired once per successful read; the parent owns lookup/tally. */
  onScan: (code: string) => void;
  title?: string;
  description?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetectorInstance | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastCodeRef = useRef<string>("");
  const lastAtRef = useRef<number>(0);
  const facingRef = useRef<"environment" | "user">("environment");

  const [error, setError] = useState("");
  const [status, setStatus] = useState<"idle" | "starting" | "live" | "unsupported">("idle");
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [manualCode, setManualCode] = useState("");

  const stop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
    setTorchOn(false);
    setHasTorch(false);
  }, []);

  const emit = useCallback(
    (raw: string) => {
      const code = normalizeBarcode(raw);
      if (!code) return;
      // Debounce identical reads so a held code does not flood the parent.
      const now = Date.now();
      if (code === lastCodeRef.current && now - lastAtRef.current < 1600) return;
      lastCodeRef.current = code;
      lastAtRef.current = now;
      onScan(code);
      onClose();
    },
    [onClose, onScan],
  );

  const loop = useCallback(async () => {
    const video = videoRef.current;
    const detector = detectorRef.current;
    if (!video || !detector || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(() => {
        void loop();
      });
      return;
    }
    try {
      const codes = await detector.detect(video);
      const raw = codes.find((c) => typeof c.rawValue === "string" && c.rawValue.trim())?.rawValue;
      if (raw) {
        emit(raw);
        return;
      }
    } catch {
      // Transient detect failures (e.g. track ended) are ignored; the loop
      // restarts or stop() tears everything down.
    }
    rafRef.current = requestAnimationFrame(() => {
      void loop();
    });
  }, [emit]);

  const start = useCallback(
    async (nextFacing: "environment" | "user") => {
      setError("");
      setStatus("starting");
      stop();

      const ctor = getBarcodeDetectorCtor();
      if (!ctor) {
        setStatus("unsupported");
        setError(
          "مرورگر این دستگاه تشخیص بارکد با دوربین را پشتیبانی نمی‌کند. کد را دستی وارد کنید یا از بارکدخوان دستی استفاده کنید.",
        );
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("unsupported");
        setError("دسترسی به دوربین در این مرورگر ممکن نیست.");
        return;
      }

      try {
        const formats = await supportedFormats(ctor);
        detectorRef.current = new ctor({ formats });

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: nextFacing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        streamRef.current = stream;
        facingRef.current = nextFacing;
        setFacing(nextFacing);

        const video = videoRef.current;
        if (!video) {
          stop();
          setStatus("idle");
          return;
        }
        video.srcObject = stream;
        await video.play();

        const track = stream.getVideoTracks()[0];
        const capabilities =
          typeof track?.getCapabilities === "function"
            ? (track.getCapabilities() as { torch?: boolean })
            : {};
        setHasTorch(Boolean(capabilities.torch));

        setStatus("live");
        rafRef.current = requestAnimationFrame(() => {
          void loop();
        });
      } catch (err) {
        stop();
        const name = err instanceof Error ? err.name : "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setError("اجازهٔ دسترسی به دوربین داده نشد. در تنظیمات مرورگر اجازه دهید و دوباره تلاش کنید.");
        } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          setError("دوربینی روی این دستگاه پیدا نشد.");
        } else {
          setError("راه‌اندازی دوربین ناموفق بود. دوباره تلاش کنید.");
        }
        setStatus("unsupported");
      }
    },
    [loop, stop],
  );

  useEffect(() => {
    if (!open) {
      stop();
      setStatus("idle");
      setManualCode("");
      setError("");
      lastCodeRef.current = "";
      return;
    }
    void start("environment");
    return () => {
      stop();
    };
  }, [open, start, stop]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== "function") return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setHasTorch(false);
    }
  }

  function submitManual(e: React.FormEvent) {
    e.preventDefault();
    const code = normalizeBarcode(manualCode);
    if (!code) return;
    emit(code);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-stone-200/80 px-4 py-3 sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <CameraIcon className="size-4 shrink-0 text-amber-700" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-xs leading-5">{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 p-4 sm:p-5">
          <div className="relative overflow-hidden rounded-2xl border border-stone-200 bg-stone-950">
            <video
              ref={videoRef}
              className="aspect-[3/4] w-full object-cover"
              playsInline
              muted
              autoPlay
            />
            {/* Aiming frame — visual only; detection runs on the full frame. */}
            <div
              className="pointer-events-none absolute inset-[18%] rounded-xl border-2 border-amber-400/90 shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]"
              aria-hidden="true"
            />
            {status === "starting" ? (
              <p className="absolute inset-x-0 bottom-3 text-center text-xs text-white/90">
                در حال آماده‌سازی دوربین…
              </p>
            ) : null}
            {status === "live" ? (
              <p className="absolute inset-x-0 bottom-3 text-center text-xs text-white/90">
                بارکد را داخل کادر نگه دارید
              </p>
            ) : null}
          </div>

          {error ? (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-800" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 flex-1"
              onClick={() => void start(facing === "environment" ? "user" : "environment")}
              disabled={status === "starting"}
            >
              <SwitchCameraIcon className="size-4" aria-hidden="true" />
              تعویض دوربین
            </Button>
            {hasTorch ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 flex-1"
                aria-pressed={torchOn}
                onClick={() => void toggleTorch()}
              >
                {torchOn ? "خاموش کردن فلاش" : "روشن کردن فلاش"}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" className="min-h-11" onClick={onClose}>
              <XIcon className="size-4" aria-hidden="true" />
              بستن
            </Button>
          </div>

          <form onSubmit={submitManual} className="space-y-2 rounded-xl border border-stone-200 bg-stone-50/80 p-3">
            <label className="block text-xs font-medium text-stone-700" htmlFor="camera-scan-manual">
              ورود دستی کد
              <span className="ms-1 font-normal text-muted-foreground">
                (اگر دوربین نخواند)
              </span>
            </label>
            <div className="flex gap-2">
              <input
                id="camera-scan-manual"
                dir="ltr"
                className="min-h-11 flex-1 rounded-lg border border-stone-200 bg-white px-3 text-sm outline-none focus-visible:border-amber-500 focus-visible:ring-3 focus-visible:ring-amber-400/40"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder="مثلاً 6260123456789"
                autoComplete="off"
                inputMode="text"
              />
              <Button type="submit" className="min-h-11 shrink-0" disabled={!manualCode.trim()}>
                تأیید
              </Button>
            </div>
            {lastCodeRef.current ? (
              <p className="text-[11px] text-muted-foreground">
                آخرین خوانده‌شده: {toPersianDigits(lastCodeRef.current)}
              </p>
            ) : null}
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Compact trigger that opens the camera scanner dialog. */
export function CameraScanTrigger({
  onScan,
  label = "دوربین",
  className,
  disabled,
  title,
  description,
}: {
  onScan: (code: string) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  description?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className={className ?? "min-h-11 gap-1.5"}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <CameraIcon className="size-4" aria-hidden="true" />
        {label}
      </Button>
      <CameraBarcodeScanner
        open={open}
        onClose={() => setOpen(false)}
        onScan={onScan}
        title={title}
        description={description}
      />
    </>
  );
}
