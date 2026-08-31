"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { BugIcon, CameraIcon, Loader2Icon, SendIcon, Trash2Icon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { captureScreenshot } from "./capture-screenshot";

export interface BugReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** True while a screenshot is being captured — the dialog and floating button hide themselves so they don't appear in the shot. */
  capturing: boolean;
  onCapturingChange: (capturing: boolean) => void;
}

export function BugReportDialog({ open, onOpenChange, capturing, onCapturingChange }: BugReportDialogProps) {
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const reset = () => {
    setDescription("");
    setScreenshot(null);
    setSubmitting(false);
  };

  const handleCapture = async () => {
    if (capturing) return;
    onCapturingChange(true);
    try {
      // The dialog unmounts itself while `capturing` is set (see `open` below)
      // so the screenshot shows the app, not the reporter. Wait until its DOM
      // node is actually gone before taking the snapshot.
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!document.querySelector('[data-slot="dialog-content"]')) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
      const shot = await captureScreenshot();
      if (shot) setScreenshot(shot);
      else toast.error("گرفتن تصویر ممکن نشد؛ می‌توانید بدون تصویر ادامه دهید.");
    } finally {
      onCapturingChange(false);
    }
  };

  const handleSubmit = async () => {
    const trimmed = description.trim();
    if (!trimmed && !screenshot) {
      toast.error("توضیح مشکل یا تصویر را وارد کنید.");
      textareaRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: trimmed,
          screenshot,
          pageUrl: window.location.href,
          userAgent: navigator.userAgent,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        }),
      });
      if (!res.ok) {
        toast.error("ثبت گزارش ناموفق بود؛ دوباره تلاش کنید.");
        return;
      }
      toast.success("گزارش شما ثبت شد. سپاس!");
      reset();
      onOpenChange(false);
    } catch {
      toast.error("خطا در ارتباط با سرور؛ دوباره تلاش کنید.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      // While a screenshot is being taken the whole dialog (overlay included)
      // steps aside so the shot captures the app underneath, not the reporter.
      open={open && !capturing}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BugIcon aria-hidden="true" className="size-5 text-destructive" />
            گزارش مشکل
          </DialogTitle>
          <DialogDescription>
            بگویید چه مشکلی پیش آمد. می‌توانید از همین صفحه عکس بگیرید و همراه توضیح بفرستید.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="bug-report-description">توضیح مشکل</Label>
            <textarea
              ref={textareaRef}
              id="bug-report-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="چه کاری انجام می‌دادید و چه خطایی دیدید؟"
              rows={4}
              className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-base leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 md:text-sm"
            />
          </div>

          {screenshot ? (
            <div className="relative overflow-hidden rounded-lg border border-stone-200/80">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={screenshot} alt="تصویر صفحه هنگام گزارش" className="max-h-56 w-full object-cover" />
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => setScreenshot(null)}
                className="absolute end-2 top-2"
              >
                <Trash2Icon aria-hidden="true" />
                حذف تصویر
              </Button>
            </div>
          ) : (
            <Button type="button" variant="outline" onClick={handleCapture} disabled={capturing} className="w-full">
              {capturing ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : <CameraIcon aria-hidden="true" />}
              {capturing ? "در حال گرفتن تصویر…" : "گرفتن تصویر از صفحه"}
            </Button>
          )}
        </div>

        <DialogFooter showCloseButton>
          <Button type="button" onClick={handleSubmit} disabled={submitting || capturing}>
            {submitting ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : <SendIcon aria-hidden="true" />}
            {submitting ? "در حال ارسال…" : "ارسال گزارش"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
