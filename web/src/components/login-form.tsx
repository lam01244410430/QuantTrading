"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };

      if (!response.ok || !payload.ok) {
        const retryAfter = response.headers.get("retry-after");
        if (response.status === 429 && retryAfter) {
          setError(`Too many sign-in attempts. Retry after ${retryAfter}s.`);
        } else {
          setError(payload.error || "Sign-in failed.");
        }
        return;
      }

      setPassword("");
      router.refresh();
    } catch {
      setError("Unable to reach authentication service.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-between px-4 py-10">
      <div className="my-auto">
        <div className="mb-5 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-accent text-accent-fg">
            <Lock className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h1 className="font-serif text-xl font-semibold leading-tight text-text">
              QuantTrading admin
            </h1>
            <p className="text-xs text-text-muted">
              Single-admin sign-in · server-verified session
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in to dashboard</CardTitle>
            <CardDescription>
              Credentials are provisioned by the operator in the backend database.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <label htmlFor="username" className="block text-xs font-semibold text-text">
                  Admin username
                </label>
                <Input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  disabled={submitting}
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="password" className="block text-xs font-semibold text-text">
                  Password
                </label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={submitting}
                />
              </div>

              {error ? (
                <div
                  role="alert"
                  className="rounded border border-negative bg-negative-bg px-3 py-2 text-xs text-negative"
                >
                  {error}
                </div>
              ) : null}

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <footer className="mt-8 border-t border-border pt-4 text-center text-xs text-text-muted">
        <p>
          Simulated synthetic backtester · No live trading, orders, or external feeds.
        </p>
        <p className="mt-1">
          Financial charts powered by{" "}
          <a
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            TradingView Lightweight Charts
          </a>{" "}
          (Apache 2.0).
        </p>
      </footer>
    </main>
  );
}
