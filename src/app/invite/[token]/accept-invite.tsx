"use client";

import { useEffect, useState } from "react";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";
import { useRouter } from "next/navigation";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "../../dashboard/ui";

interface Preview {
  businessName: string;
  email: string;
  fullName: string;
  role: string;
  hasExistingLogin: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "مالک",
  manager: "مدیر",
  accountant: "حسابدار",
};

export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const res = await api<Preview & { error?: string }>(
        `/api/auth/accept-invite?token=${encodeURIComponent(token)}`,
      );
      if (res.ok) setPreview(res.data);
      else setError(errorMessage(res.data.error));
      setLoading(false);
    })();
  }, [token]);

  async function accept() {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>("/api/auth/accept-invite", {
      method: "POST",
      body: JSON.stringify({ token, password: password || undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  if (loading) return <FormLoadingSkeleton rows={3} className="p-8" label="در حال بارگذاری دعوت‌نامه" />;

  return (
    <div className="mx-auto max-w-md space-y-4 p-8">
      <h1 className="text-xl font-bold">دعوت به همکاری</h1>
      <ErrorBox>{error}</ErrorBox>

      {preview && (
        <>
          <InfoBox>
            شما به‌عنوان «{ROLE_LABELS[preview.role] ?? preview.role}» به «{preview.businessName}»
            دعوت شده‌اید.
          </InfoBox>

          <Field label="ایمیل">
            <input className={inputClass} dir="ltr" readOnly value={preview.email} />
          </Field>

          {preview.hasExistingLogin ? (
            // They already have a platform login — this only adds a membership,
            // and their existing password keeps working unchanged.
            <InfoBox>
              این ایمیل از قبل حساب دارد. با پذیرش دعوت، این کسب‌وکار به حساب فعلی شما اضافه می‌شود
              و رمز عبورتان تغییر نمی‌کند.
            </InfoBox>
          ) : (
            <Field label="رمز عبور (حداقل ۸ نویسه)">
              <input
                className={inputClass}
                dir="ltr"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          )}

          <PrimaryButton
            onClick={accept}
            disabled={busy || (!preview.hasExistingLogin && password.length < 8)}
          >
            پذیرش دعوت
          </PrimaryButton>
        </>
      )}
    </div>
  );
}
