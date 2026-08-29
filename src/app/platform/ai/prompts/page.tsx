"use client";

import { useCallback, useEffect, useState } from "react";
import { api, Button, Card, ErrorBox, InfoBox, inputClass, useCan } from "../../ui";
import { Loader2Icon } from "lucide-react";

interface PromptVersion {
  id: string;
  version: number;
  isActive: boolean;
  createdAt: string;
}

interface Surface {
  mode: string;
  fragmentKey: string;
  activeText: string | null;
  activeVersion: number | null;
  versions: PromptVersion[];
  /** The code default, for editing against the real baseline. */
  codeDefault: string;
}

const SURFACE_LABELS: Record<string, string> = {
  wizard: "دستیار راه‌اندازی (wizard)",
  dashboard: "دستیار داشبورد مدیر (dashboard)",
  floor: "دستیار سالن (floor)",
  proactive: "گزارش‌های زمان‌بندی‌شده (proactive)",
  autopilot: "اجرای خودکار (autopilot)",
  platform: "دستیار پشتیبانی پلتفرم (platform)",
};

/**
 * The prompt manager's platform layer. An active override replaces the
 * code-built system prompt for that surface everywhere, on every install;
 * clearing it falls back to the code default. The default is shown read-only
 * beside the editor so an admin always knows what they are departing from.
 */
export default function PlatformPromptsPage() {
  const can = useCan();
  const [surfaces, setSurfaces] = useState<Surface[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [showDefault, setShowDefault] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api<{ surfaces: Surface[]; error?: string }>("/api/platform/prompts");
    if (!result.ok) {
      setError(result.data.error ?? "خواندن پرامپت‌ها ممکن نشد.");
      setLoading(false);
      return;
    }
    setSurfaces(result.data.surfaces);
    setDrafts(
      Object.fromEntries(
        result.data.surfaces.map((surface) => [surface.mode, surface.activeText ?? ""]),
      ),
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(mode: string) {
    setBusy(mode);
    setError("");
    setNotice("");
    const result = await api<{ error?: string }>("/api/platform/prompts", {
      method: "PUT",
      body: JSON.stringify({ mode, text: drafts[mode] ?? "" }),
    });
    setBusy("");
    if (!result.ok) {
      setError(result.data.error ?? "ذخیره ممکن نشد.");
      return;
    }
    setNotice("پرامپت ذخیره شد و از همین لحظه روی همهٔ نصب‌ها اعمال می‌شود.");
    await load();
  }

  async function clear(mode: string) {
    setBusy(mode + ":clear");
    setError("");
    setNotice("");
    const result = await api<{ error?: string }>(
      `/api/platform/prompts?mode=${encodeURIComponent(mode)}`,
      { method: "DELETE" },
    );
    setBusy("");
    if (!result.ok) {
      setError(result.data.error ?? "بازگردانی ممکن نشد.");
      return;
    }
    setNotice("پرامپت سفارشی حذف شد و پیش‌فرض کد بازگشت.");
    await load();
  }

  if (loading) {
    return <p className="text-sm text-white/50">در حال بارگذاری مدیر پرامپت…</p>;
  }

  const editable = can("ai.config.manage");

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 sm:space-y-6">
      <header>
        <h1 className="text-xl font-bold">مدیریت پرامپت‌ها</h1>
        <p className="mt-1 text-sm text-white/50">
          پرامپت سیستم هر سطحی که دستیار در آن پاسخ می‌دهد. نسخهٔ فعال جایگزین پیش‌فرض کد می‌شود؛
          حذف آن همیشه به پیش‌فرض بازمی‌گردد. حاشیهٔ کسب‌وکارها از بخش تنظیمات هوش مصنوعی خودشان اضافه می‌شود، نه از این‌جا.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      {!editable ? <InfoBox>مشاهده فقط-خواندنی؛ ویرایش به مالک پلتفرم محدود است.</InfoBox> : null}

      {(surfaces ?? []).map((surface) => (
        <Card key={surface.mode} title={SURFACE_LABELS[surface.mode] ?? surface.mode}>
          <div className="space-y-3">
            <p className="text-xs text-white/50">
              {surface.activeText
                ? `نسخهٔ فعال: v${surface.activeVersion} از ${surface.versions.length} نسخهٔ ذخیره‌شده`
                : "در حال استفاده از پیش‌فرض کد"}
            </p>
            <textarea
              className={`${inputClass} min-h-44 font-normal leading-7`}
              dir="rtl"
              value={drafts[surface.mode] ?? ""}
              placeholder={editable ? "خالی = استفاده از پیش‌فرض کد" : ""}
              disabled={!editable}
              onChange={(event) =>
                setDrafts((current) => ({ ...current, [surface.mode]: event.target.value }))
              }
            />
            <div className="flex flex-wrap items-center gap-2">
              {editable ? (
                <>
                  <Button onClick={() => void save(surface.mode)} disabled={Boolean(busy)}>
                    {busy === surface.mode ? <Loader2Icon className="animate-spin" /> : null}
                    ذخیره و فعال‌سازی
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void clear(surface.mode)}
                    disabled={Boolean(busy) || !surface.activeText}
                  >
                    {busy === surface.mode + ":clear" ? <Loader2Icon className="animate-spin" /> : null}
                    بازگردانی پیش‌فرض کد
                  </Button>
                </>
              ) : null}
              <Button
                variant="ghost"
                onClick={() =>
                  setShowDefault((current) => (current === surface.mode ? null : surface.mode))
                }
              >
                {showDefault === surface.mode ? "بستن پیش‌فرض" : "نمایش پیش‌فرض کد"}
              </Button>
            </div>
            {showDefault === surface.mode ? (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/20 p-3 text-xs leading-6 text-white/70">
                {surface.codeDefault}
              </pre>
            ) : null}
            {surface.versions.length > 0 ? (
              <p className="text-[11px] text-white/40">
                تاریخچه: {surface.versions.map((v) => `v${v.version}${v.isActive ? "①" : ""}`).join(" · ")}
              </p>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  );
}
