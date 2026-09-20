"use client";

/**
 * The visual stock-count dialog — camera, photo and video in, a confirmed
 * Persian number out.
 *
 * The flow in one paragraph: the operator picks a source (live camera, a
 * photo, a video file). If the item already has a «برچسب تصویری» (visual
 * profile), every frame is counted by the pure classical-CV engine in
 * `src/lib/vision/` — color-signature masking or Hough circles, no AI, no
 * network — and the count is drawn as boxes over the preview. If it doesn't,
 * the first captured still becomes the tagging surface: the operator taps
 * one unit (the engine finds the color region under the finger) or boxes it
 * with two taps, or asks the metered AI vision model to propose the box and
 * the count. Whatever produced the number, the operator sees the boxes,
 * edits the count if it looks wrong, and only then does it leave this dialog
 * — «افزودن به شمارش» hands the tally a reviewed number plus an evidence
 * payload the panel stores beside it.
 *
 * Camera lifecycle follows `camera-barcode-scanner.tsx`'s proven shapes: a
 * session counter so a late permission prompt can't leak a stream, exact
 * then ideal facing constraints, torch when the hardware offers it, and
 * Persian-first errors for every way getUserMedia fails. Nothing here posts a
 * stock movement — the stock-counts form stays the only write path.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CameraIcon,
  CircleDotIcon,
  CrosshairIcon,
  FileVideoIcon,
  ImagePlusIcon,
  PlayIcon,
  ScanIcon,
  SparklesIcon,
  SwitchCameraIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { LoadingSkeleton, StatusBadge, TabBar } from "@/app/dashboard/page-chrome";
import { api, inputClass } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { MAX_IMAGE_DATA_URL_CHARS, type VisualProfileRecord } from "@/lib/inventory-visual-profiles";
import type { Box, NormalizedBox, VisionImage } from "@/lib/vision/image";
import { denormalizeBox, normalizeBox } from "@/lib/vision/image";
import {
  buildProfileFromRegion,
  countWithProfile,
  regionAtPoint,
  type CountResult,
  type VisualProfileFeatures,
} from "@/lib/vision/count";
import { mapBoxThroughContain, mapBoxThroughCover, medianOf, pointFromViewToFrame } from "@/lib/vision/overlay";
import {
  EVIDENCE_IMAGE_MAX_DIM,
  PROFILE_IMAGE_MAX_DIM,
  frameFromVideoElement,
  imageFromFile,
  toStoredJpegDataUrl,
  unloadVideoElement,
  videoElementFromFile,
} from "@/lib/vision/browser";
import type { InventoryItem } from "./inventory-manager";

/** Longest edge for the JPEG kept for display/AI upload (analysis size). */
const ANALYSIS_STORE_DIM = 640;

/** What the panel needs to record the evidence and apply the tally. */
export interface VisionApplyPayload {
  inventoryItemId: string;
  /** The operator-confirmed quantity (ASCII digits, possibly decimal). */
  countedQty: string;
  /** Whether the number adds to the item's tally or replaces it. */
  mode: "add" | "replace";
  method: "cv_color" | "cv_round" | "ai_vision";
  confidence: number;
  boxes: NormalizedBox[];
  imageDataUrl: string;
}

type SourceTab = "live" | "photo" | "video";
type CameraFacing = "environment" | "user";
type TagMode = "off" | "tap" | "box-first" | "box-second";

interface StillFrame {
  image: VisionImage;
  /** A display/storage JPEG of the same frame the boxes were computed on. */
  dataUrl: string;
  result: CountResult | null;
  source: SourceTab;
}

interface LiveCount {
  count: number;
  confidence: number;
  boxes: Box[];
}

interface AiCount {
  count: number;
  confidence: number;
  box: NormalizedBox | null;
  comment: string;
}

const SOURCE_TABS: readonly { key: SourceTab; label: string }[] = [
  { key: "live", label: "دوربین زنده" },
  { key: "photo", label: "از عکس" },
  { key: "video", label: "از ویدیو" },
];

function stopMediaStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "اجازهٔ دسترسی به دوربین داده نشد. در تنظیمات مرورگر اجازه دهید و دوباره تلاش کنید.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "دوربینی روی این دستگاه پیدا نشد. می‌توانید از سربرگ «از عکس» استفاده کنید.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "دوربین در برنامه یا برگهٔ دیگری در حال استفاده است. آن را ببندید و دوباره تلاش کنید.";
  }
  return "راه‌اندازی دوربین ناموفق بود. دوباره تلاش کنید یا از «از عکس» استفاده کنید.";
}

async function requestCameraStream(facing: CameraFacing): Promise<MediaStream> {
  const constraints = (exact: boolean): MediaStreamConstraints => ({
    audio: false,
    video: {
      facingMode: exact ? { exact: facing } : { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  try {
    return await navigator.mediaDevices.getUserMedia(constraints(true));
  } catch (error) {
    const retryable = ["OverconstrainedError", "ConstraintNotSatisfiedError", "NotFoundError", "DevicesNotFoundError", "TypeError"];
    if (!retryable.includes(error instanceof Error ? error.name : "")) throw error;
    return await navigator.mediaDevices.getUserMedia(constraints(false));
  }
}

function confidenceBadge(confidence: number): { tone: "positive" | "active" | "danger"; label: string } {
  if (confidence >= 0.75) return { tone: "positive", label: "اطمینان بالا" };
  if (confidence >= 0.45) return { tone: "active", label: "اطمینان متوسط" };
  return { tone: "danger", label: "اطمینان کم — بازبینی کنید" };
}

const METHOD_LABELS: Record<VisionApplyPayload["method"], string> = {
  cv_color: "شمارش رنگ",
  cv_round: "شکل دایره‌ای",
  ai_vision: "هوش مصنوعی",
};

export function VisionCountDialog({
  open,
  onClose,
  item,
  profiles,
  onProfileSaved,
  onProfileDeleted,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  item: InventoryItem;
  profiles: VisualProfileRecord[];
  onProfileSaved: () => void;
  onProfileDeleted: () => void;
  /** Receives only operator-confirmed numbers; never called automatically. */
  onApply: (payload: VisionApplyPayload) => void;
}) {
  const [tab, setTab] = useState<SourceTab>("live");
  const [still, setStill] = useState<StillFrame | null>(null);
  const [liveCount, setLiveCount] = useState<LiveCount | null>(null);
  const [cameraStatus, setCameraStatus] = useState<"idle" | "starting" | "live" | "unsupported">("idle");
  const [cameraError, setCameraError] = useState("");
  const [facing, setFacing] = useState<CameraFacing>("environment");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [tagMode, setTagMode] = useState<TagMode>("off");
  const [tagBoxStart, setTagBoxStart] = useState<{ x: number; y: number } | null>(null);
  const [pendingTagBox, setPendingTagBox] = useState<Box | null>(null);
  /** Who proposed the pending tag — the operator ('manual') or the model ('ai'). */
  const [pendingTagSource, setPendingTagSource] = useState<"manual" | "ai">("manual");
  const [tagHint, setTagHint] = useState("");
  const [savingTag, setSavingTag] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiCount, setAiCount] = useState<AiCount | null>(null);
  const [aiError, setAiError] = useState("");
  const [qty, setQty] = useState("");
  const [applying, setApplying] = useState(false);
  const [appliedNote, setAppliedNote] = useState("");
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  /** Running median + latest boxes over the sampled video frames. */
  const [videoSampleCount, setVideoSampleCount] = useState(0);
  const [videoLiveBoxes, setVideoLiveBoxes] = useState<Box[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef(0);
  const liveTimerRef = useRef<number | null>(null);
  const videoTimerRef = useRef<number | null>(null);
  /** The post-apply "next shot" timer — cleared when the dialog closes so a
   *  closed dialog can never restart the camera on its own. */
  const applyTimerRef = useRef<number | null>(null);
  const photoInputId = useId();
  const videoInputId = useId();
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const stillViewRef = useRef<HTMLDivElement | null>(null);
  const liveViewRef = useRef<HTMLDivElement | null>(null);
  const fileVideoViewRef = useRef<HTMLDivElement | null>(null);
  /** Video sampling results for the median, kept on a ref (not render state). */
  const videoSamplesRef = useRef<Array<{ count: number; boxes: Box[]; image: VisionImage; dataUrl: string }>>([]);

  const latestProfile = profiles[0] ?? null;
  const hasProfile = profiles.length > 0;

  const stopLiveCounting = useCallback(() => {
    if (liveTimerRef.current !== null) {
      window.clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    sessionRef.current += 1;
    stopLiveCounting();
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    const video = videoRef.current;
    if (video) video.srcObject = null;
    setCameraStatus("idle");
    setTorchOn(false);
    setTorchAvailable(false);
    setLiveCount(null);
  }, [stopLiveCounting]);

  const stopVideoSampling = useCallback(() => {
    if (videoTimerRef.current !== null) {
      window.clearInterval(videoTimerRef.current);
      videoTimerRef.current = null;
    }
    setVideoPlaying(false);
  }, []);

  /** The sampled video's intrinsic frame size, for the cover overlay math. */
  function fileVideoFrame(): { width: number; height: number } | null {
    const video = fileVideoRef.current;
    if (!video || !video.videoWidth) return null;
    return { width: video.videoWidth, height: video.videoHeight };
  }

  const resetStill = useCallback(() => {
    setStill(null);
    setTagMode("off");
    setTagBoxStart(null);
    setPendingTagBox(null);
    setPendingTagSource("manual");
    setTagHint("");
    setAiCount(null);
    setAiError("");
    setQty("");
    setAppliedNote("");
  }, []);

  /** Runs the engine on a frame with the item's best profile. */
  const countFrame = useCallback(
    (image: VisionImage): CountResult | null => {
      if (profiles.length === 0) return null;
      // Stills grade every profile and keep the most confident one; the live
      // loop uses only the newest profile, to stay light on a phone.
      const candidates = profiles.map((p) => countWithProfile(image, p.features));
      const usable = candidates.filter((r) => r.count > 0);
      const pool = usable.length > 0 ? usable : candidates;
      return pool.reduce((best, r) => (r.confidence > best.confidence ? r : best));
    },
    [profiles],
  );

  const startLiveCounting = useCallback(() => {
    if (!latestProfile) return;
    stopLiveCounting();
    const session = sessionRef.current;
    liveTimerRef.current = window.setInterval(() => {
      if (sessionRef.current !== session) {
        stopLiveCounting();
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      const frame = frameFromVideoElement(video);
      if (!frame) return;
      const result = countWithProfile(frame, latestProfile.features);
      setLiveCount({ count: result.count, confidence: result.confidence, boxes: result.boxes });
    }, 1100);
  }, [latestProfile, stopLiveCounting]);

  const startCamera = useCallback(
    async (nextFacing: CameraFacing) => {
      stopCamera();
      const session = sessionRef.current;
      setCameraError("");
      setCameraStatus("starting");

      await Promise.resolve();
      if (sessionRef.current !== session) return;

      if (window.isSecureContext === false) {
        setCameraStatus("unsupported");
        setCameraError("برای استفاده از دوربین، سامانه را با نشانی امن HTTPS باز کنید.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraStatus("unsupported");
        setCameraError("دسترسی به دوربین در این مرورگر ممکن نیست؛ از سربرگ «از عکس» استفاده کنید.");
        return;
      }

      let stream: MediaStream;
      try {
        stream = await requestCameraStream(nextFacing);
      } catch (error) {
        if (sessionRef.current !== session) return;
        setCameraStatus("unsupported");
        setCameraError(cameraErrorMessage(error));
        return;
      }
      if (sessionRef.current !== session) {
        stopMediaStream(stream);
        return;
      }

      streamRef.current = stream;
      setFacing(nextFacing);
      const track = stream.getVideoTracks()[0];
      try {
        const capabilities =
          typeof track?.getCapabilities === "function"
            ? (track.getCapabilities() as { torch?: boolean })
            : {};
        setTorchAvailable(Boolean(capabilities.torch));
      } catch {
        setTorchAvailable(false);
      }

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          // Autoplay policies are satisfied (muted + playsInline); a rejection
          // here still leaves a first frame for capture.
        }
      }
      setCameraStatus("live");
      startLiveCounting();
    },
    [startLiveCounting, stopCamera],
  );

  // Reset transient state whenever the dialog (re)opens.
  useEffect(() => {
    if (!open) return;
    setTab("live");
    resetStill();
    setVideoBusy(false);
    setVideoPlaying(false);
    setHasVideo(false);
    setVideoSampleCount(0);
    setVideoLiveBoxes([]);
    stopVideoSampling();
    unloadVideoElement(fileVideoRef.current);
    fileVideoRef.current = null;
    videoSamplesRef.current = [];
    return () => {
      if (applyTimerRef.current !== null) {
        window.clearTimeout(applyTimerRef.current);
        applyTimerRef.current = null;
      }
      stopCamera();
      stopVideoSampling();
      unloadVideoElement(fileVideoRef.current);
      fileVideoRef.current = null;
    };
  }, [open, resetStill, stopCamera, stopVideoSampling]);

  // The sampled <video> element is React-unmanaged DOM inside the video tab's
  // host div: re-attach it whenever the tab remounts (tab switches unmount
  // the host) and pause sampling whenever the operator looks elsewhere.
  useEffect(() => {
    if (tab !== "video") {
      stopVideoSampling();
      const video = fileVideoRef.current;
      if (video && !video.paused) video.pause();
      return;
    }
    const host = fileVideoViewRef.current;
    const video = fileVideoRef.current;
    if (host && video && video.parentElement !== host) {
      host.innerHTML = "";
      host.appendChild(video);
    }
  }, [tab, stopVideoSampling]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== "function") return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  }

  /** Freezes the current camera frame into the still/result view. */
  function captureLiveFrame() {
    const video = videoRef.current;
    if (!video) return;
    const frame = frameFromVideoElement(video);
    if (!frame) {
      setCameraError("تصویری از دوربین گرفته نشد؛ دوباره تلاش کنید.");
      return;
    }
    const dataUrl = toStoredJpegDataUrl(frame, ANALYSIS_STORE_DIM, MAX_IMAGE_DATA_URL_CHARS);
    if (!dataUrl) {
      setCameraError("ذخیرهٔ تصویر ممکن نشد؛ دوباره تلاش کنید.");
      return;
    }
    const result = countFrame(frame);
    stopCamera();
    openStill({ image: frame, dataUrl, result, source: "live" });
  }

  function openStill(frame: StillFrame) {
    setStill(frame);
    setAiCount(null);
    setAiError("");
    setAppliedNote("");
    setQty(frame.result && frame.result.count > 0 ? String(frame.result.count) : "");
    // No profile yet → this still is the tagging surface.
    if (!hasProfile) {
      setTagMode("tap");
      setTagHint("روی یکی از نمونه‌های سالم قلم بزنید تا به‌عنوان مرجع ذخیره شود.");
    } else {
      setTagMode("off");
      setTagHint("");
    }
  }

  async function handlePhotoFile(file: File) {
    const image = await imageFromFile(file);
    if (!image) {
      setTagHint("این تصویر خوانده نشد؛ عکس دیگری انتخاب کنید.");
      return;
    }
    const dataUrl = toStoredJpegDataUrl(image, ANALYSIS_STORE_DIM, MAX_IMAGE_DATA_URL_CHARS);
    if (!dataUrl) {
      setTagHint("ذخیرهٔ این عکس ممکن نشد؛ عکس کوچک‌تری انتخاب کنید.");
      return;
    }
    const result = countFrame(image);
    setTab("photo");
    openStill({ image, dataUrl, result, source: "photo" });
  }

  async function handleVideoFile(file: File) {
    setVideoBusy(true);
    setTagHint("");
    try {
      const video = await videoElementFromFile(file);
      if (fileVideoRef.current) unloadVideoElement(fileVideoRef.current);
      fileVideoRef.current = video;
      videoSamplesRef.current = [];
      setVideoSampleCount(0);
      setVideoLiveBoxes([]);
      // The element must be attached to the DOM before it will play; the
      // re-attach effect above owns the host, so this only primes playback.
      const host = fileVideoViewRef.current;
      if (host) {
        host.innerHTML = "";
        host.appendChild(video);
        video.className = "aspect-[3/4] w-full object-cover";
        video.controls = false;
        await video.play().catch(() => undefined);
        setVideoPlaying(true);
        startVideoSampling();
      }
      setHasVideo(true);
    } catch {
      setTagHint("این ویدیو خوانده نشد؛ فایل دیگری انتخاب کنید.");
    } finally {
      setVideoBusy(false);
    }
  }

  function startVideoSampling() {
    const video = fileVideoRef.current;
    if (!video) return;
    stopVideoSampling();
    videoTimerRef.current = window.setInterval(() => {
      if (!fileVideoRef.current) {
        stopVideoSampling();
        return;
      }
      const v = fileVideoRef.current;
      if (v.ended) {
        stopVideoSampling();
        return;
      }
      if (v.paused) return;
      const frame = frameFromVideoElement(v);
      if (!frame || !latestProfile) return;
      const result = countWithProfile(frame, latestProfile.features);
      const dataUrl = toStoredJpegDataUrl(frame, EVIDENCE_IMAGE_MAX_DIM, MAX_IMAGE_DATA_URL_CHARS);
      if (!dataUrl) return;
      videoSamplesRef.current.push({ count: result.count, boxes: result.boxes, image: frame, dataUrl });
      if (videoSamplesRef.current.length > 40) videoSamplesRef.current.shift();
      setVideoSampleCount(videoSamplesRef.current.length);
      setVideoLiveBoxes(result.boxes);
      setVideoPlaying(true);
    }, 900);
    video.onended = () => stopVideoSampling();
  }

  function confirmVideoCount() {
    const samples = videoSamplesRef.current;
    const video = fileVideoRef.current;
    if (samples.length === 0 || !video || !latestProfile) {
      setTagHint("ابتدا ویدیو را پخش کنید تا چند فریم شمارش شود.");
      return;
    }
    stopVideoSampling();
    video.pause();
    const median = Math.round(medianOf(samples.map((s) => s.count)));
    // The representative frame: the sampled frame whose count equals the
    // median, latest first, so the evidence photo shows what the number says.
    const representative = [...samples].reverse().find((s) => s.count === median) ?? samples[samples.length - 1];
    const displayUrl = toStoredJpegDataUrl(representative.image, ANALYSIS_STORE_DIM, MAX_IMAGE_DATA_URL_CHARS);
    const result: CountResult = {
      count: median,
      confidence: Math.min(
        0.9,
        representative.boxes.length ? 0.5 + 0.4 * (median > 0 ? 1 : 0) : 0.3,
      ),
      boxes: representative.boxes,
      method: latestProfile.features.kind === "round" ? "cv_round" : "cv_color",
      detail: `میانهٔ ${toPersianDigits(samples.length)} فریم نمونه‌برداری‌شده.`,
    };
    openStill({
      image: representative.image,
      dataUrl: displayUrl ?? representative.dataUrl,
      result,
      source: "video",
    });
    unloadVideoElement(fileVideoRef.current);
    fileVideoRef.current = null;
    setHasVideo(false);
    videoSamplesRef.current = [];
  }

  /** Tap on the still: tag a unit, draw a manual box, or nothing. */
  function handleStillClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!still || tagMode === "off") return;
    const view = stillViewRef.current;
    if (!view) return;
    const rect = view.getBoundingClientRect();
    const point = pointFromViewToFrame(
      event.clientX - rect.left,
      event.clientY - rect.top,
      { width: still.image.width, height: still.image.height },
      { width: rect.width, height: rect.height },
      "contain",
    );

    if (tagMode === "box-first") {
      setTagBoxStart(point);
      setTagMode("box-second");
      setTagHint("حالا گوشهٔ مقابل همان نمونه را بزنید.");
      return;
    }
    if (tagMode === "box-second" && tagBoxStart) {
      const box: Box = {
        x: Math.min(tagBoxStart.x, point.x),
        y: Math.min(tagBoxStart.y, point.y),
        w: Math.abs(point.x - tagBoxStart.x),
        h: Math.abs(point.y - tagBoxStart.y),
      };
      setTagBoxStart(null);
      setTagMode("off");
      reviewTagBox(box);
      return;
    }
    if (tagMode === "tap") {
      const hit = regionAtPoint(still.image, point.x, point.y);
      if (!hit) {
        setTagHint("ناحیه‌ای مشخص پیدا نشد. روی خود قلم بزنید، یا «کادر دستی» را امتحان کنید.");
        return;
      }
      reviewTagBox(hit.box);
    }
  }

  function reviewTagBox(box: Box, source: "manual" | "ai" = "manual") {
    const built = buildProfileFromRegion(still!.image, box);
    if (!built) {
      setTagHint("این کادر برای برچسب مناسب نیست؛ کادر فقط خود یک نمونهٔ قلم را بگیرد.");
      return;
    }
    setPendingTagBox(box);
    setPendingTagSource(source);
    setTagHint("");
  }

  async function saveTag(source: "manual" | "ai", box: Box, features: VisualProfileFeatures) {
    if (!still) return;
    setSavingTag(true);
    setTagHint("");
    const imageDataUrl = toStoredJpegDataUrl(still.image, PROFILE_IMAGE_MAX_DIM, MAX_IMAGE_DATA_URL_CHARS);
    if (!imageDataUrl) {
      setSavingTag(false);
      setTagHint("ذخیرهٔ تصویر مرجع ممکن نشد؛ دوباره تلاش کنید.");
      return;
    }
    const { ok, data } = await api<{ error?: string }>("/api/inventory/visual-profiles", {
      method: "POST",
      body: JSON.stringify({
        inventoryItemId: item.id,
        source,
        kind: features.kind,
        imageDataUrl,
        region: normalizeBox(box, still.image),
        features,
      }),
    });
    setSavingTag(false);
    if (!ok) {
      setTagHint(
        data.error === "profile_limit_reached"
          ? "سقف برچسب‌های این قلم پر شده؛ یکی از برچسب‌های قبلی را حذف کنید."
          : "ذخیرهٔ برچسب ناموفق بود؛ دوباره تلاش کنید.",
      );
      return;
    }
    setPendingTagBox(null);
    setTagMode("off");
    onProfileSaved();
    // A fresh profile means this still can be counted right now — do it, so
    // the operator sees the payoff of tagging immediately.
    const result = countWithProfile(still.image, features);
    setStill({ ...still, result });
    setQty(result.count > 0 ? String(result.count) : "");
    setTagHint("برچسب ذخیره شد و شمارش خودکار همین تصویر انجام شد.");
  }

  async function runAiCount() {
    if (!still) return;
    setAiBusy(true);
    setAiError("");
    setAiCount(null);
    const { ok, data } = await api<{
      error?: string;
      message?: string;
      count?: number;
      confidence?: number;
      box?: NormalizedBox | null;
      comment?: string;
    }>("/api/ai/inventory-vision", {
      method: "POST",
      body: JSON.stringify({ image: still.dataUrl, inventoryItemId: item.id }),
    });
    setAiBusy(false);
    if (!ok || typeof data.count !== "number") {
      setAiError(data.message ?? "شمارش هوشمند ناموفق بود؛ دوباره تلاش کنید.");
      return;
    }
    const result: AiCount = {
      count: data.count,
      confidence: typeof data.confidence === "number" ? data.confidence : 0.5,
      box: data.box ?? null,
      comment: data.comment ?? "",
    };
    setAiCount(result);
    setQty(String(result.count));
    // An AI box on a profile-less item doubles as a proposed profile — offer
    // it as a saved tag so future counts run free and offline.
    if (result.box && !hasProfile) {
      const box = denormalizeBox(result.box, still.image);
      const built = buildProfileFromRegion(still.image, box);
      if (built) reviewTagBox(box, "ai");
    }
  }

  function applyCount(mode: "add" | "replace") {
    if (!still) return;
    const value = qty.trim();
    if (!value || !/^\d+(\.\d{1,3})?$/.test(value)) {
      setTagHint("مقدار شمارش را وارد کنید.");
      return;
    }
    const source = aiCount ? "ai_vision" : still.result?.method ?? "ai_vision";
    const confidence = aiCount ? aiCount.confidence : still.result?.confidence ?? 0;
    const boxes = aiCount
      ? aiCount.box
        ? [aiCount.box]
        : []
      : still.result
        ? still.result.boxes.map((b) => normalizeBox(b, still.image))
        : [];
    const evidenceUrl = toStoredJpegDataUrl(still.image, EVIDENCE_IMAGE_MAX_DIM, MAX_IMAGE_DATA_URL_CHARS);
    if (!evidenceUrl) {
      setTagHint("ذخیرهٔ تصویر شواهد ممکن نشد؛ دوباره تلاش کنید.");
      return;
    }
    setApplying(true);
    onApply({
      inventoryItemId: item.id,
      countedQty: value,
      mode,
      method: source,
      confidence,
      boxes,
      imageDataUrl: evidenceUrl,
    });
    setApplying(false);
    setAppliedNote(
      mode === "add"
        ? `${toPersianDigits(value)} به شمارش این قلم اضافه شد.`
        : `شمارش این قلم روی ${toPersianDigits(value)} ثبت شد.`,
    );
    // Stay open: the operator usually photographs the next shelf right away.
    if (applyTimerRef.current !== null) window.clearTimeout(applyTimerRef.current);
    applyTimerRef.current = window.setTimeout(() => {
      applyTimerRef.current = null;
      resetStill();
      if (tab === "live") void startCamera(facing);
    }, 900);
  }

  const stillBoxes = useMemo(() => {
    if (!still) return [];
    if (aiCount?.box) return [denormalizeBox(aiCount.box, still.image)];
    if (pendingTagBox) return [pendingTagBox];
    return still.result?.boxes ?? [];
  }, [still, aiCount, pendingTagBox]);

  /** Draws the counted/tagged boxes over the still preview (object-contain). */
  const drawStillOverlay = useCallback(() => {
    const view = stillViewRef.current;
    const canvas = view?.querySelector("canvas") as HTMLCanvasElement | null;
    if (!view || !canvas || !still) return;
    const rect = view.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const frame = { width: still.image.width, height: still.image.height };
    const view2 = { width: canvas.width, height: canvas.height };
    for (const box of stillBoxes) {
      const mapped = mapBoxThroughContain(box, frame, view2);
      if (!mapped) continue;
      ctx.lineWidth = 2.5;
      // A dark hairline under the amber stroke keeps the box readable over
      // both bright and dark photos.
      ctx.strokeStyle = "rgb(28 25 23 / 0.85)";
      ctx.strokeRect(mapped.x - 0.5, mapped.y - 0.5, mapped.w + 1, mapped.h + 1);
      ctx.strokeStyle = pendingTagBox === box ? "rgb(45 212 191)" : "rgb(251 191 36)";
      ctx.strokeRect(mapped.x, mapped.y, mapped.w, mapped.h);
    }
  }, [still, stillBoxes, pendingTagBox]);

  /** Draws live-count boxes over the camera/video preview (object-cover). */
  const drawCoverOverlay = useCallback(
    (viewRef: React.RefObject<HTMLDivElement | null>, boxes: Box[], frame: { width: number; height: number } | null) => {
      const view = viewRef.current;
      const canvas = view?.querySelector("canvas") as HTMLCanvasElement | null;
      if (!view || !canvas || !frame) return;
      const rect = view.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      canvas.width = rect.width;
      canvas.height = rect.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const box of boxes) {
        const mapped = mapBoxThroughCover(box, frame, { width: canvas.width, height: canvas.height });
        if (!mapped) continue;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "rgb(28 25 23 / 0.85)";
        ctx.strokeRect(mapped.x - 0.5, mapped.y - 0.5, mapped.w + 1, mapped.h + 1);
        ctx.strokeStyle = "rgb(251 191 36)";
        ctx.strokeRect(mapped.x, mapped.y, mapped.w, mapped.h);
      }
    },
    [],
  );

  // Redraw overlays whenever the boxes or the layout change.
  useEffect(() => {
    drawStillOverlay();
    const onResize = () => {
      drawStillOverlay();
      drawCoverOverlay(
        liveViewRef,
        liveCount?.boxes ?? [],
        videoRef.current && videoRef.current.videoWidth
          ? { width: videoRef.current.videoWidth, height: videoRef.current.videoHeight }
          : null,
      );
      drawCoverOverlay(fileVideoViewRef, videoLiveBoxes, fileVideoFrame());
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [drawStillOverlay, drawCoverOverlay, liveCount, videoLiveBoxes]);

  // Live camera overlay: redraw whenever a new frame's boxes arrive.
  useEffect(() => {
    if (!liveCount) return;
    const video = videoRef.current;
    drawCoverOverlay(
      liveViewRef,
      liveCount.boxes,
      video && video.videoWidth ? { width: video.videoWidth, height: video.videoHeight } : null,
    );
  }, [liveCount, drawCoverOverlay]);

  // Sampled video overlay: boxes of the latest sampled frame.
  useEffect(() => {
    if (tab !== "video") return;
    drawCoverOverlay(fileVideoViewRef, videoLiveBoxes, fileVideoFrame());
  }, [videoLiveBoxes, tab, drawCoverOverlay]);

  const confidence = aiCount ? aiCount.confidence : still?.result?.confidence ?? 0;
  const effectiveCount = aiCount ? aiCount.count : still?.result?.count ?? 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/80 px-4 py-3 sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <CameraIcon className="size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
            شمارش تصویری — {item.name}
          </DialogTitle>
          <DialogDescription className="text-xs leading-5">
            {hasProfile
              ? "شمارش خودکار با برچسب تصویری این قلم انجام می‌شود؛ نتیجه را بررسی و تأیید کنید."
              : "این قلم هنوز برچسب تصویری ندارد؛ ابتدا یک نمونه از آن را برچسب بزنید تا شمارش خودکار فعال شود."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 p-4 sm:p-5">
          {still ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    resetStill();
                    if (tab === "live") void startCamera(facing);
                  }}
                >
                  بازگشت
                </Button>
                {effectiveCount > 0 || aiCount ? (
                  <div className="flex items-center gap-2">
                    <StatusBadge tone={confidenceBadge(confidence).tone}>
                      {confidenceBadge(confidence).label}
                    </StatusBadge>
                    <StatusBadge tone="neutral">{aiCount ? METHOD_LABELS.ai_vision : METHOD_LABELS[still.result?.method ?? "cv_color"]}</StatusBadge>
                  </div>
                ) : null}
              </div>

              <div
                ref={stillViewRef}
                className="relative overflow-hidden rounded-2xl border border-border bg-black"
                onClick={handleStillClick}
                role={tagMode === "off" ? undefined : "button"}
                tabIndex={tagMode === "off" ? -1 : 0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    // Keyboard tagging falls back to the image center.
                    if (tagMode === "tap" && still) {
                      const hit = regionAtPoint(still.image, still.image.width / 2, still.image.height / 2);
                      if (hit) reviewTagBox(hit.box);
                    }
                  }
                }}
              >
                { }
                <img
                  src={still.dataUrl}
                  alt={`تصویر شمارش ${item.name}`}
                  className="max-h-[52vh] w-full object-contain"
                />
                <canvas className="pointer-events-none absolute inset-0 size-full" aria-hidden="true" />
                {tagMode === "tap" || tagMode === "box-first" || tagMode === "box-second" ? (
                  <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
                    <span className="rounded-full bg-black/60 px-3 py-1 text-xs text-white">
                      {tagMode === "tap"
                        ? "روی یکی از نمونه‌های قلم بزنید"
                        : tagMode === "box-first"
                          ? "گوشهٔ اول کادر یک نمونه را بزنید"
                          : "گوشهٔ مقابل را بزنید"}
                    </span>
                  </div>
                ) : null}
              </div>

              {tagHint ? (
                <p className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-xs leading-5 text-amber-950 dark:text-amber-200" role="status">
                  {tagHint}
                </p>
              ) : null}

              {aiBusy ? (
                <LoadingSkeleton rows={2} label="در حال شمارش هوشمند" />
              ) : null}

              {aiError ? (
                <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive" role="alert">
                  {aiError}
                </p>
              ) : null}

              {aiCount ? (
                <div className="rounded-xl border border-border bg-muted/60 px-3 py-2 text-sm">
                  <p className="font-semibold">
                    شمارش هوش مصنوعی: {toPersianDigits(aiCount.count)} {item.unit}
                  </p>
                  {aiCount.comment ? (
                    <p className="mt-1 text-xs text-muted-foreground">{aiCount.comment}</p>
                  ) : null}
                </div>
              ) : null}

              {effectiveCount > 0 && !aiCount && still.result ? (
                <p className="text-xs text-muted-foreground">{still.result.detail}</p>
              ) : null}

              {pendingTagBox ? (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/60 p-3">
                  <p className="flex-1 min-w-40 text-xs text-muted-foreground">
                    کادر سبز، نمونهٔ مرجع است
                    {pendingTagSource === "ai" ? " (پیشنهاد هوش مصنوعی)" : ""}. ذخیرهٔ آن شمارش
                    همهٔ تصاویر بعدی این قلم را خودکار می‌کند.
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11"
                    disabled={savingTag}
                    onClick={() => {
                      setPendingTagBox(null);
                      setPendingTagSource("manual");
                      if (!hasProfile) {
                        setTagMode("tap");
                        setTagHint("روی یکی از نمونه‌های سالم قلم بزنید تا به‌عنوان مرجع ذخیره شود.");
                      }
                    }}
                  >
                    انصراف
                  </Button>
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={savingTag}
                    onClick={() => {
                      if (!still || !pendingTagBox) return;
                      const built = buildProfileFromRegion(still.image, pendingTagBox);
                      if (!built) return;
                      void saveTag(pendingTagSource, pendingTagBox, built.profile);
                    }}
                  >
                    {savingTag ? "در حال ذخیرهٔ برچسب…" : "ذخیرهٔ برچسب تصویری"}
                  </Button>
                </div>
              ) : null}

              {!hasProfile && !pendingTagBox ? (
                <div className="flex flex-wrap gap-2">
                  {tagMode !== "tap" ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 flex-1"
                      onClick={() => {
                        setTagMode("tap");
                        setTagHint("روی یکی از نمونه‌های سالم قلم بزنید تا به‌عنوان مرجع ذخیره شود.");
                      }}
                    >
                      <CrosshairIcon className="size-4" aria-hidden="true" />
                      برچسب با لمس نمونه
                    </Button>
                  ) : null}
                  {tagMode !== "box-first" && tagMode !== "box-second" ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 flex-1"
                      onClick={() => {
                        setTagMode("box-first");
                        setTagBoxStart(null);
                        setTagHint("گوشهٔ اول کادر دور یک نمونهٔ کامل از قلم را بزنید.");
                      }}
                    >
                      <ScanIcon className="size-4" aria-hidden="true" />
                      کادر دستی
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 flex-1"
                    onClick={() => void runAiCount()}
                    disabled={aiBusy}
                  >
                    <SparklesIcon className="size-4" aria-hidden="true" />
                    {aiBusy ? "در حال شمارش هوشمند…" : "برچسب‌گذاری و شمارش با هوش مصنوعی"}
                  </Button>
                </div>
              ) : null}

              {hasProfile ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 w-full"
                  onClick={() => void runAiCount()}
                  disabled={aiBusy}
                >
                  <SparklesIcon className="size-4" aria-hidden="true" />
                  {aiBusy ? "در حال شمارش هوشمند…" : "شمارش با هوش مصنوعی (اعتبار مصرف می‌شود)"}
                </Button>
              ) : null}

              <div className="rounded-xl border border-border p-3">
                <label className="grid gap-1 text-xs font-medium">
                  <span>مقدار شمارش‌شده ({item.unit})</span>
                  <PersianNumberInput
                    className={inputClass}
                    dir="ltr"
                    inputMode="decimal"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    placeholder="مثلاً ۱۲"
                  />
                </label>
                {appliedNote ? (
                  <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300" role="status">
                    {appliedNote}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    size="lg"
                    className="min-h-11 flex-1 font-semibold"
                    onClick={() => applyCount("add")}
                    disabled={applying || !qty.trim()}
                  >
                    {applying ? "در حال ثبت…" : "افزودن به شمارش"}
                  </Button>
                  <Button
                    type="button"
                    size="lg"
                    variant="outline"
                    className="min-h-11 flex-1"
                    onClick={() => applyCount("replace")}
                    disabled={applying || !qty.trim()}
                  >
                    ثبت به‌جای مقدار فعلی
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <TabBar
                idPrefix="vision-count-source"
                label="منبع تصویر"
                tabs={SOURCE_TABS}
                active={tab}
                onChange={(key) => {
                  if (key !== "live") stopCamera();
                  setTab(key);
                }}
              />

              {tab === "live" ? (
                <div className="space-y-3">
                  {cameraStatus === "live" ? (
                    <>
                      <div ref={liveViewRef} className="relative overflow-hidden rounded-2xl border border-border bg-black">
                        <video ref={videoRef} className="aspect-[3/4] w-full object-cover" playsInline muted autoPlay />
                        <canvas className="pointer-events-none absolute inset-0 size-full" aria-hidden="true" />
                        <div
                          className="pointer-events-none absolute inset-[18%] rounded-xl border-2 border-amber-400/90 dark:border-amber-500/50 shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]"
                          aria-hidden="true"
                        />
                        {liveCount ? (
                          <div className="absolute top-2 start-2 rounded-full bg-black/60 px-3 py-1 text-sm font-semibold text-white">
                            {hasProfile
                              ? `شمارش زنده: ${toPersianDigits(liveCount.count)} ${item.unit}`
                              : "برای شمارش زنده، ابتدا برچسب تصویری ذخیره کنید"}
                          </div>
                        ) : null}
                        {cameraStatus === "live" ? (
                          <p className="absolute inset-x-0 bottom-3 text-center text-xs text-white/90" aria-live="polite">
                            {hasProfile ? "قلم‌ها را در کادر نگه دارید" : "یک عکس بگیرید و نمونهٔ قلم را برچسب بزنید"}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="lg"
                          className="min-h-11 flex-1 font-semibold"
                          onClick={captureLiveFrame}
                        >
                          <CircleDotIcon className="size-4" aria-hidden="true" />
                          گرفتن تصویر
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          onClick={() => void startCamera(facing === "environment" ? "user" : "environment")}
                        >
                          <SwitchCameraIcon className="size-4" aria-hidden="true" />
                          تعویض دوربین
                        </Button>
                        {torchAvailable ? (
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            aria-pressed={torchOn}
                            onClick={() => void toggleTorch()}
                          >
                            {torchOn ? "خاموش کردن فلاش" : "روشن کردن فلاش"}
                          </Button>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div className="space-y-3 rounded-xl border border-dashed border-border px-4 py-6 text-center">
                      <CameraIcon className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
                      <p className="text-sm text-muted-foreground">
                        دوربین را باز کنید، از قلم‌ها تصویر بگیرید و شمارش خودکار را ببینید.
                      </p>
                      <Button
                        type="button"
                        className="min-h-11"
                        onClick={() => void startCamera("environment")}
                        disabled={cameraStatus === "starting"}
                      >
                        {cameraStatus === "starting" ? "در حال آماده‌سازی دوربین…" : "شروع دوربین"}
                      </Button>
                    </div>
                  )}
                  {cameraError ? (
                    <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive" role="alert">
                      {cameraError}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {tab === "photo" ? (
                <div className="space-y-3">
                  <input
                    ref={photoInputRef}
                    id={photoInputId}
                    className="sr-only"
                    type="file"
                    accept="image/*"
                    capture="environment"
                    tabIndex={-1}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void handlePhotoFile(file);
                    }}
                  />
                  <div className="space-y-3 rounded-xl border border-dashed border-border px-4 py-6 text-center">
                    <ImagePlusIcon className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">
                      عکس موجودی قلم را انتخاب کنید؛ شمارش خودکار روی همان عکس انجام می‌شود.
                    </p>
                    <Button
                      type="button"
                      className="min-h-11"
                      onClick={() => photoInputRef.current?.click()}
                    >
                      انتخاب عکس
                    </Button>
                  </div>
                  {tagHint ? (
                    <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive" role="alert">
                      {tagHint}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {tab === "video" ? (
                <div className="space-y-3">
                  <input
                    ref={videoInputRef}
                    id={videoInputId}
                    className="sr-only"
                    type="file"
                    accept="video/*"
                    capture="environment"
                    tabIndex={-1}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void handleVideoFile(file);
                    }}
                  />
                  <div ref={fileVideoViewRef} className="relative overflow-hidden rounded-2xl border border-border bg-black empty:p-0">
                    {/* The sampled <video> element is attached here. */}
                    {videoSampleCount > 0 ? (
                      <div className="pointer-events-none absolute top-2 start-2 rounded-full bg-black/60 px-3 py-1 text-sm font-semibold text-white">
                        شمارش تا اینجا:{" "}
                        {toPersianDigits(Math.round(medianOf(videoSamplesRef.current.map((s) => s.count))))}{" "}
                        {item.unit}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 flex-1"
                      onClick={() => videoInputRef.current?.click()}
                      disabled={videoBusy}
                    >
                      <FileVideoIcon className="size-4" aria-hidden="true" />
                      {videoBusy ? "در حال باز کردن ویدیو…" : "انتخاب ویدیو"}
                    </Button>
                    {hasVideo ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          onClick={() => {
                            const video = fileVideoRef.current;
                            if (!video) return;
                            if (video.paused) {
                              void video.play().then(() => {
                                setVideoPlaying(true);
                                startVideoSampling();
                              });
                            } else {
                              video.pause();
                              stopVideoSampling();
                            }
                          }}
                        >
                          <PlayIcon className="size-4" aria-hidden="true" />
                          {videoPlaying ? "توقف" : "پخش"}
                        </Button>
                        <Button
                          type="button"
                          className="min-h-11 flex-1 font-semibold"
                          onClick={confirmVideoCount}
                        >
                          تأیید شمارش ویدیو
                        </Button>
                      </>
                    ) : null}
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {latestProfile
                      ? "در حین پخش، هر ثانیه چند فریم نمونه‌برداری و شمارش می‌شود؛ عدد نهایی میانهٔ همهٔ فریم‌هاست. برای قفسه‌های بلند، ویدیو را آرام و ثابت بگیرید."
                      : "برای شمارش ویدیو، ابتدا از سربرگ «از عکس» یک برچسب تصویری برای این قلم ذخیره کنید."}
                  </p>
                  {tagHint ? (
                    <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive" role="alert">
                      {tagHint}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
