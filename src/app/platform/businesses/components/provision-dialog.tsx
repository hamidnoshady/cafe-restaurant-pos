"use client";

/**
 * The business provisioning wizard, lifted out of the directory list body into
 * its own dialog with logical steps (task section 7): identity → owner → review.
 * Creating a business here seeds the chart of accounts, enrols the owner's
 * second factor and returns one-time recovery material the operator hands over.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Industry } from "@/lib/industries";
import { validateSubdomain } from "@/lib/slug";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PlatformField, PlatformFormSection } from "@/components/platform/form";
import { PlatformInlineError } from "@/components/platform/states";
import { usePlatformMutation } from "../../_lib/use-platform-data";
import { platformErrorText } from "@/lib/platform-errors";
import { IndustryPicker } from "../../industry-picker";

interface ProvisionMfaHandover {
  method: "totp" | "sms_otp";
  totpSecret: string | null;
  totpUrl: string | null;
  totpQr: string | null;
  recoveryCodes: string[];
}

type Step = "identity" | "owner" | "review" | "handover";

export function ProvisionDialog({
  open,
  onOpenChange,
  rootDomain,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootDomain: string;
  onCreated: () => void;
}) {
  const [step, setStep] = useState<Step>("identity");
  const [businessName, setBusinessName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [industry, setIndustry] = useState<Industry>("food_service");
  const [locationName, setLocationName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [handover, setHandover] = useState<ProvisionMfaHandover | null>(null);

  const subdomainError = subdomain ? validateSubdomain(subdomain) : null;

  const create = usePlatformMutation<void, { mfa?: ProvisionMfaHandover }>(
    "/api/platform/businesses",
    {
      method: "POST",
      request: () => ({
        options: {
          body: {
            businessName: businessName.trim(),
            ownerName: ownerName.trim(),
            email: email.trim().toLowerCase(),
            password,
            ownerPhone: ownerPhone.trim(),
            locationName: locationName.trim() || undefined,
            subdomain,
            industry,
          },
        },
      }),
      errorToast: false,
      onSuccess: (data) => {
        if (data.mfa && (data.mfa.recoveryCodes?.length || data.mfa.totpSecret)) {
          setHandover(data.mfa);
          setStep("handover");
        } else {
          toast.success("کسب‌وکار ایجاد شد.");
          reset();
          onCreated();
        }
      },
    },
  );

  function reset() {
    setStep("identity");
    setBusinessName("");
    setSubdomain("");
    setIndustry("food_service");
    setLocationName("");
    setOwnerName("");
    setEmail("");
    setPassword("");
    setOwnerPhone("");
    setHandover(null);
    create.reset();
  }

  function close() {
    if (create.busy) return;
    reset();
    onOpenChange(false);
  }

  const identityValid = businessName.trim() && subdomain && !subdomainError;
  const ownerValid = ownerName.trim() && email.trim() && password.length >= 8 && ownerPhone.trim();

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(v) : close())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {step === "handover" && handover ? (
          <HandoverPanel
            handover={handover}
            ownerEmail={email.trim().toLowerCase()}
            onDone={() => {
              reset();
              onCreated();
            }}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>ایجاد کسب‌وکار جدید</DialogTitle>
              <DialogDescription>
                {step === "identity"
                  ? "گام ۱ از ۳ — هویت و نشانی کسب‌وکار"
                  : step === "owner"
                    ? "گام ۲ از ۳ — اطلاعات مالک"
                    : "گام ۳ از ۳ — بازبینی و ایجاد"}
              </DialogDescription>
            </DialogHeader>

            {create.errorText ? <PlatformInlineError>{create.errorText}</PlatformInlineError> : null}

            {step === "identity" ? (
              <PlatformFormSection>
                <PlatformField label="نام کسب‌وکار" htmlFor="pv-name" required>
                  <Input id="pv-name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
                </PlatformField>
                <PlatformField
                  label="نشانی اینترنتی (زیردامنه)"
                  htmlFor="pv-sub"
                  required
                  error={subdomainError ? platformErrorText(subdomainError) : undefined}
                  description={
                    subdomain && rootDomain && !subdomainError
                      ? `کسب‌وکار از این نشانی سرو می‌شود: https://${subdomain}.${rootDomain}`
                      : rootDomain
                        ? `نام انگلیسی کسب‌وکار؛ نشانی زیر ${rootDomain} ساخته می‌شود.`
                        : "فقط حروف انگلیسی کوچک، رقم و خط تیره."
                  }
                >
                  <Input
                    id="pv-sub"
                    dir="ltr"
                    value={subdomain}
                    onChange={(e) => setSubdomain(e.target.value.trim().toLowerCase())}
                    placeholder="acme"
                  />
                </PlatformField>
                <PlatformField
                  label="نوع کسب‌وکار"
                  description="سرفصل حساب‌ها، مراحل راه‌اندازی و ماژول‌ها بر اساس این انتخاب ساخته می‌شوند."
                >
                  <IndustryPicker value={industry} onChange={setIndustry} disabled={create.busy} />
                </PlatformField>
                <PlatformField label="نام شعبه" htmlFor="pv-loc" description="خالی بماند، «شعبه مرکزی» ساخته می‌شود.">
                  <Input id="pv-loc" value={locationName} onChange={(e) => setLocationName(e.target.value)} />
                </PlatformField>
              </PlatformFormSection>
            ) : null}

            {step === "owner" ? (
              <PlatformFormSection>
                <PlatformField label="نام مالک" htmlFor="pv-owner" required>
                  <Input id="pv-owner" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
                </PlatformField>
                <PlatformField label="ایمیل مالک" htmlFor="pv-email" required>
                  <Input id="pv-email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
                </PlatformField>
                <PlatformField label="رمز عبور مالک" htmlFor="pv-pass" required description="حداقل ۸ نویسه.">
                  <Input id="pv-pass" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
                </PlatformField>
                <PlatformField
                  label="موبایل مالک"
                  htmlFor="pv-phone"
                  required
                  description="کد ورود دومرحله‌ای به این شماره پیامک می‌شود."
                >
                  <Input id="pv-phone" type="tel" dir="ltr" placeholder="09121234567" value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} />
                </PlatformField>
              </PlatformFormSection>
            ) : null}

            {step === "review" ? (
              <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <ReviewRow label="نام کسب‌وکار" value={businessName} />
                <ReviewRow label="نشانی" value={`${subdomain}.${rootDomain}`} dir="ltr" />
                <ReviewRow label="نوع" value={industry} />
                <ReviewRow label="مالک" value={`${ownerName} — ${email}`} dir="ltr" />
                <ReviewRow label="موبایل مالک" value={ownerPhone} dir="ltr" />
                <p className="pt-2 text-xs text-muted-foreground">
                  با ایجاد، سرفصل حساب‌ها ساخته می‌شود و اطلاعات ورود دومرحله‌ای مالک یک‌بار نمایش داده می‌شود.
                </p>
              </div>
            ) : null}

            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={create.busy}>
                انصراف
              </Button>
              {step === "identity" ? (
                <Button onClick={() => setStep("owner")} disabled={!identityValid}>
                  بعدی
                </Button>
              ) : step === "owner" ? (
                <>
                  <Button variant="outline" onClick={() => setStep("identity")}>
                    قبلی
                  </Button>
                  <Button onClick={() => setStep("review")} disabled={!ownerValid}>
                    بعدی
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setStep("owner")} disabled={create.busy}>
                    قبلی
                  </Button>
                  <Button onClick={() => create.mutate()} disabled={create.busy}>
                    {create.busy ? "در حال ایجاد…" : "ایجاد و راه‌اندازی"}
                  </Button>
                </>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReviewRow({ label, value, dir }: { label: string; value: string; dir?: "ltr" | "rtl" }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-end text-foreground" dir={dir}>
        {value}
      </span>
    </div>
  );
}

/**
 * The one and only showing of the new owner's second-factor material. Held
 * until the operator confirms hand-over — these values cannot be recovered
 * (the TOTP secret is stored encrypted, the codes only as bcrypt hashes).
 */
function HandoverPanel({
  handover,
  ownerEmail,
  onDone,
}: {
  handover: ProvisionMfaHandover;
  ownerEmail: string;
  onDone: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <>
      <DialogHeader>
        <DialogTitle>ورود دومرحله‌ای مالک — فقط یک‌بار نمایش داده می‌شود</DialogTitle>
        <DialogDescription>
          کسب‌وکار ساخته شد. موارد زیر را به مالک ({ownerEmail}) تحویل دهید و نزد خود نگه ندارید؛ پس
          از بستن این پنجره دیگر قابل نمایش نیستند.
        </DialogDescription>
      </DialogHeader>

      {handover.method === "sms_otp" ? (
        <p className="text-sm text-muted-foreground">
          روش اصلی ورود دومرحله‌ای این مالک، پیامک یک‌بارمصرف به شمارهٔ موبایلی است که وارد کردید.
        </p>
      ) : null}

      {handover.totpQr ? (
        <div className="flex justify-center">
          { }
          <img src={handover.totpQr} alt="کد QR ورود دومرحله‌ای" className="size-44 rounded-lg bg-card p-2" />
        </div>
      ) : null}

      {handover.totpSecret ? (
        <div>
          <p className="mb-1 text-sm text-muted-foreground">کد دستی برنامهٔ رمزساز:</p>
          <p dir="ltr" className="rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm tracking-wider">
            {handover.totpSecret}
          </p>
        </div>
      ) : null}

      {handover.recoveryCodes.length > 0 ? (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">
            ۱۰ کد بازیابی یک‌بارمصرف — تنها راه ورود مالک در صورت گم‌شدن گوشی:
          </p>
          <div dir="ltr" className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm tracking-wider">
            {handover.recoveryCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(handover.recoveryCodes.join("\n"));
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "کپی شد" : "کپی کدها"}
          </Button>
        </div>
      ) : null}

      <label className="flex items-start gap-2 text-sm text-foreground">
        <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
        <span>این اطلاعات را به مالک تحویل دادم.</span>
      </label>

      <DialogFooter>
        <Button disabled={!confirmed} onClick={onDone}>
          بستن
        </Button>
      </DialogFooter>
    </>
  );
}
