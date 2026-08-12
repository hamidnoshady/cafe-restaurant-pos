"use client";

/**
 * The apex host's "which business?" router (Phase 21 Wave 3).
 *
 * Under subdomain routing each business is served from its own origin, so the
 * bare `pos.eshobe.com` no longer has a tenant to show. It becomes a
 * signpost instead: identify yourself, see the businesses you belong to, and
 * click through to one of their hosts to actually log in.
 *
 * Nothing is authenticated here and no cookie is set — a session only ever
 * exists on a business's own origin, which is what makes it host-scoped.
 */
import { useState } from "react";

interface DirectoryEntry {
  name: string;
  subdomain: string;
  role: string;
  url: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "مالک",
  manager: "مدیر",
  accountant: "حسابدار",
  cashier: "صندوق‌دار",
  waiter: "گارسون",
  kitchen: "آشپزخانه",
};

export function BusinessDirectory() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businesses, setBusinesses] = useState<DirectoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (!res.ok) {
      setError("ایمیل یا رمز عبور نادرست است.");
      return;
    }
    const data = (await res.json()) as { businesses: DirectoryEntry[] };
    setBusinesses(data.businesses);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl bg-card p-8 shadow-sm">
        <h1 className="mb-1 text-center text-xl font-bold">سیستم فروش کافه و رستوران</h1>
        <p className="mb-6 text-center text-sm text-muted-foreground">
          هر کسب‌وکار نشانی اینترنتی خودش را دارد. برای دیدن فهرست کسب‌وکارهای خود وارد شوید.
        </p>

        {businesses ? (
          businesses.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              کسب‌وکار فعالی برای این حساب پیدا نشد.
            </p>
          ) : (
            <ul className="space-y-2">
              {businesses.map((b) => (
                <li key={b.subdomain}>
                  <a
                    href={b.url ?? "#"}
                    className="flex items-center justify-between rounded-lg border border-input px-4 py-3 transition hover:border-primary"
                  >
                    <span>
                      <span className="block font-semibold">{b.name}</span>
                      <span className="block text-xs text-muted-foreground" dir="ltr">
                        {b.subdomain}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">{ROLE_LABELS[b.role] ?? b.role}</span>
                  </a>
                </li>
              ))}
            </ul>
          )
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="directory-email" className="mb-1 block text-sm text-muted-foreground">
                ایمیل
              </label>
              <input
                id="directory-email"
                type="email"
                dir="ltr"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="directory-password" className="mb-1 block text-sm text-muted-foreground">
                رمز عبور
              </label>
              <input
                id="directory-password"
                type="password"
                dir="ltr"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-input px-3 py-2 focus:border-primary focus:outline-none"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50"
            >
              {busy ? "در حال بررسی…" : "نمایش کسب‌وکارها"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
