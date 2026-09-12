"use client";

/**
 * A live, true-to-paper preview of a template.
 *
 * It renders the *exact* HTML that will be printed — `renderPrintTemplate`'s
 * output, in a sandboxed iframe — rather than a React re-implementation of the
 * layout. That is the whole reason the renderer is a pure string function: a
 * second implementation for the screen is a second thing to keep in sync, and
 * the first time it drifts a shop prints something it never saw.
 *
 * The iframe is scaled with a CSS transform so an A4 page fits a phone without
 * the preview lying about proportions: 210mm stays 210mm, it is just drawn
 * smaller.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PAPERS, renderPrintTemplate, type PrintDocumentData, type PrintTemplate } from "@/lib/print-template";

const MM_TO_PX = 96 / 25.4;

export function TemplatePreview({
  template,
  data,
  className,
  maxHeightPx = 520,
}: {
  template: PrintTemplate;
  data: PrintDocumentData;
  className?: string;
  /** The preview box's height; the page scales to fit inside it. */
  maxHeightPx?: number;
}) {
  const paper = PAPERS[template.paper];
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [measured, setMeasured] = useState(false);

  const html = useMemo(() => renderPrintTemplate(template, data), [template, data]);
  const pageWidthPx = paper.widthMm * MM_TO_PX;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const fit = () => {
      const available = element.clientWidth;
      if (available <= 0) return;
      setScale(Math.min(1, available / pageWidthPx));
      setMeasured(true);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [pageWidthPx]);

  // A roll has no page height, so the preview gives it a generous canvas and
  // lets the box scroll; a sheet is shown at its real aspect ratio.
  const pageHeightPx = (paper.heightMm ?? 400) * MM_TO_PX;
  const scaledHeight = Math.min(maxHeightPx, pageHeightPx * scale);

  return (
    <div ref={containerRef} className={className}>
      {!measured ? <Skeleton aria-label="آماده‌سازی پیش‌نمایش" className="h-64 w-full rounded-xl" /> : null}
      <div
        className="overflow-auto rounded-xl border border-border/80 bg-muted/40 p-3"
        style={{ height: measured ? scaledHeight + 24 : 0, opacity: measured ? 1 : 0 }}
      >
        <div style={{ width: pageWidthPx * scale, height: pageHeightPx * scale, margin: "0 auto" }}>
          <iframe
            title="پیش‌نمایش چاپ"
            sandbox=""
            srcDoc={html}
            className="border-0 bg-card"
            style={{
              width: pageWidthPx,
              height: pageHeightPx,
              transform: `scale(${scale})`,
              transformOrigin: "top right",
            }}
          />
        </div>
      </div>
    </div>
  );
}
