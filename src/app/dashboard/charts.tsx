"use client";

/**
 * Minimal chart primitives for dashboard widgets/report previews — plain
 * SVG, no charting library (matches the app's existing "hand-roll it"
 * conventions, e.g. src/lib/jalali.ts, src/lib/escpos.ts). Colors come from
 * the validated categorical palette in globals.css (--chart-1..8, fixed hue
 * order, never cycled — see the dataviz skill).
 */
import { toPersianDigits } from "@/lib/digits";

export type ChartDatum = { label: string; value: number };

const PALETTE = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-chart-6)",
  "var(--color-chart-7)",
  "var(--color-chart-8)",
];

function fmt(n: number): string {
  return toPersianDigits(Math.round(n).toLocaleString("en-US"));
}

export function NumberCard({ label, value, sublabel }: { label: string; value: string; sublabel?: string }) {
  return (
    <div className="flex h-full flex-col justify-center gap-1 p-2">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-3xl font-bold tabular-nums">{value}</p>
      {sublabel ? <p className="text-xs text-muted-foreground">{sublabel}</p> : null}
    </div>
  );
}

/** Horizontal bars — reads better than vertical columns for RTL and long entity labels (item/staff names), and needs no axis rotation. Single series: one hue, no legend (title already says what's plotted). */
export function BarChart({ data, height = 220 }: { data: ChartDatum[]; height?: number }) {
  if (data.length === 0) return <EmptyChart height={height} />;
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const rowH = Math.max(22, Math.min(32, height / data.length));

  return (
    <div className="flex flex-col gap-1.5 overflow-y-auto" style={{ maxHeight: height }}>
      {data.map((d, i) => {
        const pct = (Math.abs(d.value) / max) * 100;
        return (
          <div key={i} className="flex items-center gap-2" style={{ height: rowH }}>
            <span className="w-20 shrink-0 truncate text-xs text-muted-foreground" title={d.label}>
              {d.label}
            </span>
            <div className="relative h-4 flex-1 rounded-full bg-muted">
              <div
                className="h-4 rounded-full"
                style={{ width: `${pct}%`, background: PALETTE[0] }}
                title={`${d.label}: ${fmt(d.value)}`}
              />
            </div>
            <span className="w-16 shrink-0 text-end text-xs tabular-nums text-foreground">{fmt(d.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 2px line, round joins, end-dot + direct end-label (the value the story is about), hairline gridlines. */
export function LineChart({ data, height = 220 }: { data: ChartDatum[]; height?: number }) {
  if (data.length === 0) return <EmptyChart height={height} />;
  const width = 480;
  const padding = { top: 16, bottom: 24, left: 8, right: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const values = data.map((d) => d.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;

  const points = data.map((d, i) => {
    const x = padding.left + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
    const y = padding.top + innerH - ((d.value - min) / range) * innerH;
    return { x, y, ...d };
  });
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const zeroY = padding.top + innerH - ((0 - min) / range) * innerH;
  const last = points[points.length - 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
      <line x1={padding.left} y1={zeroY} x2={width - padding.right} y2={zeroY} stroke="var(--color-border)" strokeWidth={1} />
      <path d={path} fill="none" stroke={PALETTE[0]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={4} fill={PALETTE[0]} stroke="var(--color-card)" strokeWidth={2}>
          <title>{`${p.label}: ${fmt(p.value)}`}</title>
        </circle>
      ))}
      <text x={last.x} y={last.y - 10} textAnchor="middle" fontSize={11} fill="var(--color-foreground)" className="tabular-nums">
        {fmt(last.value)}
      </text>
    </svg>
  );
}

/** Donut — legend always present (≥2 series need the dependable identity channel, never color-matching alone). */
export function PieChart({ data, height = 220 }: { data: ChartDatum[]; height?: number }) {
  if (data.length === 0) return <EmptyChart height={height} />;
  const total = data.reduce((s, d) => s + Math.abs(d.value), 0) || 1;
  const size = 160;
  const r = 60;
  const cx = size / 2;
  const cy = size / 2;
  let angle = -90;

  const arcs = data.map((d, i) => {
    const frac = Math.abs(d.value) / total;
    const startAngle = angle;
    angle += frac * 360;
    const endAngle = angle;
    const large = frac > 0.5 ? 1 : 0;
    const toXY = (a: number) => {
      const rad = (a * Math.PI) / 180;
      return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };
    const [x1, y1] = toXY(startAngle);
    const [x2, y2] = toXY(endAngle);
    const path = `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
    return { path, color: PALETTE[i % PALETTE.length], ...d, pct: frac * 100 };
  });

  return (
    // h-full so a widget tile's fixed height wins; maxHeight so a report
    // preview (whose parent has no height) still caps the legend at the
    // chart's height budget instead of stretching the card without end —
    // the same budget BarChart already enforces on itself.
    <div className="flex h-full items-center gap-4" style={{ maxHeight: height }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="shrink-0">
        <circle cx={cx} cy={cy} r={r} fill="var(--color-muted)" />
        {arcs.map((a, i) => (
          <path key={i} d={a.path} fill={a.color} stroke="var(--color-card)" strokeWidth={2}>
            <title>{`${a.label}: ${fmt(a.value)} (${a.pct.toFixed(0)}%)`}</title>
          </path>
        ))}
        <circle cx={cx} cy={cy} r={r * 0.55} fill="var(--color-card)" />
      </svg>
      <ul className="min-h-0 min-w-0 flex-1 space-y-1 self-stretch overflow-y-auto pe-1 text-xs">
        {arcs.map((a, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.color }} />
            <span className="truncate text-muted-foreground">{a.label}</span>
            <span className="ms-auto shrink-0 tabular-nums text-foreground">{fmt(a.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyChart({ height }: { height: number }) {
  return (
    <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height }}>
      داده‌ای برای نمایش وجود ندارد.
    </div>
  );
}
