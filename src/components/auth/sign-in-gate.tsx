"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useTranslations } from "next-intl";
import { Eye, EyeOff, LoaderCircle, LockKeyhole } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FayaNMSLockup } from "@/components/brand";
import { cn } from "@/lib/utils";

/**
 * Sign-in gate (Task 7-a) — rendered by the app shell INSTEAD of the
 * platform whenever the next-auth session is missing (ADR-02: single route,
 * no dedicated sign-in page).
 *
 * Uses signIn("credentials", { redirect: false }) so failures surface inline
 * (wrong password → generic credentials error; disabled accounts →
 * "Account disabled" — the authorize() thrown message), and success simply
 * refreshes the server components/session so the shell takes over.
 */

const DEMO_ACCOUNTS: { email: string; name: string; role: string }[] = [
  { email: "admin@faya.local", name: "Amal Al-Sabri", role: "admin" },
  { email: "noc1@faya.local", name: "Yousef Ghalib", role: "operator" },
  { email: "engineer1@faya.local", name: "Mariam Al-Hakimi", role: "engineer" },
  { email: "manager1@faya.local", name: "Salma Al-Attar", role: "manager" },
  { email: "auditor1@faya.local", name: "Tariq Bashiri", role: "auditor" },
];

const DEMO_PASSWORD = "faya123";

const ROLE_TONE: Record<string, string> = {
  admin: "bg-primary/10 text-primary-ink",
  operator: "bg-success/10 text-success",
  engineer: "bg-info/10 text-info",
  manager: "bg-warning/10 text-warning",
  auditor: "bg-danger-orange/10 text-danger-orange",
};

export function SignInGate() {
  const t = useTranslations("auth.signIn");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const result = await signIn("credentials", {
        redirect: false,
        email: email.trim(),
        password,
      });
      if (result?.error) {
        // authorize() surfaces "Account disabled" for inactive accounts and
        // the generic CredentialsSignin for unknown/wrong credentials.
        // NextAuth error CODES are never translated — only the display copy
        // for the CredentialsSignin case; any other error string (server-
        // sent, e.g. "Account disabled") renders verbatim.
        setError(
          result.error === "CredentialsSignin"
            ? t("errorCredentials")
            : result.error
        );
        setPending(false);
        return;
      }
      // Success → re-render the app shell with the new session.
      router.refresh();
    } catch {
      setError(t("errorServer"));
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-4xl">
          <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
            {/* Brand + sign-in form */}
            <section
              aria-labelledby="sign-in-title"
              className="rounded-2xl border bg-card p-6 shadow-e2 md:p-8"
            >
              {/* Canonical tiled lockup (re-audit B1-003): the identity is
                  composed ONLY through the lockup — name and descriptor come
                  from FAYANMS_BRAND, never literals. Large tile per the
                  sign-in minimum (B2-019). */}
              <h1 id="sign-in-title" className="contents">
                <FayaNMSLockup showDescriptor tileSize="lg" variant="tiled" />
              </h1>

              <p className="mt-6 text-sm text-muted-foreground">
                {t("subtitle")}
              </p>

              <form className="mt-4 flex flex-col gap-4" onSubmit={submit}>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="sign-in-email">{t("email")}</Label>
                  <Input
                    id="sign-in-email"
                    type="email"
                    autoComplete="username"
                    placeholder="you@faya.local"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="sign-in-password">{t("password")}</Label>
                  <div className="relative">
                    <Input
                      id="sign-in-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="••••••••"
                      required
                      className="pe-10"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={t(showPassword ? "hidePassword" : "showPassword")}
                      className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => setShowPassword((prev) => !prev)}
                    >
                      {showPassword ? (
                        <EyeOff aria-hidden="true" className="size-4" />
                      ) : (
                        <Eye aria-hidden="true" className="size-4" />
                      )}
                    </button>
                  </div>
                </div>

                {error && (
                  <p
                    role="alert"
                    className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
                  >
                    {error}
                  </p>
                )}

                <Button type="submit" disabled={pending} className="mt-1 h-10">
                  {pending ? (
                    <>
                      <LoaderCircle
                        aria-hidden="true"
                        className="size-4 animate-spin"
                      />
                      {t("submitting")}
                    </>
                  ) : (
                    <>
                      <LockKeyhole aria-hidden="true" className="size-4" />
                      {t("submit")}
                    </>
                  )}
                </Button>
              </form>
            </section>

            {/* Demo block — all copy sourced from auth.signIn (RT-020) */}
            <aside
              aria-label={t("demoAsideLabel")}
              className="flex flex-col gap-4 rounded-2xl border bg-card/60 p-6 md:p-8"
            >
              <div>
                <h2 className="text-sm font-semibold">{t("demoTitle")}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t.rich("demoPasswordHint", {
                    code: DEMO_PASSWORD,
                    tech: (chunks) => (
                      <code className="ltr-technical rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {chunks}
                      </code>
                    ),
                  })}
                </p>
              </div>
              <ul className="flex flex-col gap-2">
                {DEMO_ACCOUNTS.map((account) => (
                  <li key={account.email}>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        setEmail(account.email);
                        setPassword(DEMO_PASSWORD);
                        setError(null);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2.5 text-start transition-colors",
                        "hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        "disabled:cursor-not-allowed disabled:opacity-60"
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {account.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {account.email}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          ROLE_TONE[account.role] ?? "bg-muted text-muted-foreground"
                        )}
                      >
                        {account.role}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-auto text-[11px] leading-relaxed text-muted-foreground">
                {t("privacyNote")}
              </p>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
