"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Clock,
  LogOut,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import type {
  AuthUser,
  BacktestDetail,
  BacktestRun,
  Candle,
  ContractIssue,
  Interval,
  RunStatus,
} from "@/lib/types";
import {
  CONTRACT_VERSION,
  DEFAULT_BACKTEST_REQUEST,
  formatDrawdownPercent,
  validateBacktestRequest,
} from "@/lib/contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TradingCharts } from "@/components/trading-charts";

interface DashboardClientProps {
  user: AuthUser;
  initialRuns: BacktestRun[];
  initialDetail: BacktestDetail | null;
  initialCandles: Candle[];
  backendUnavailable?: boolean;
}

const POLL_INITIAL_DELAY_MS = 400;
const POLL_MAX_DELAY_MS = 2000;
const POLL_MAX_ATTEMPTS = 15;
const POLL_MAX_ELAPSED_MS = 20_000;

function formatSigned(value: string): string {
  if (!value) return value;
  if (value.startsWith("-") || value === "0" || value === "0.00") return value;
  return `+${value}`;
}

function formatUtcSeconds(ts: number | null | undefined, includeTime = true): string {
  if (ts === null || ts === undefined) return "-";
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return String(ts);
  const iso = d.toISOString();
  return includeTime ? iso.replace("T", " ").replace(".000Z", " UTC") : iso.slice(0, 10);
}

function statusBadgeVariant(status: RunStatus): "default" | "positive" | "negative" | "warning" {
  switch (status) {
    case "succeeded":
      return "positive";
    case "failed":
      return "negative";
    case "queued":
    case "running":
      return "warning";
    default:
      return "default";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

export function DashboardClient({
  user,
  initialRuns,
  initialDetail,
  initialCandles,
  backendUnavailable = false,
}: DashboardClientProps) {
  const router = useRouter();
  const [interval, setInterval] = React.useState<Interval>(
    initialDetail?.request.interval ?? DEFAULT_BACKTEST_REQUEST.interval
  );
  const [startingCapital, setStartingCapital] = React.useState(
    initialDetail?.request.starting_capital ?? DEFAULT_BACKTEST_REQUEST.starting_capital
  );
  const [positionSize, setPositionSize] = React.useState(
    initialDetail?.request.position_size ?? DEFAULT_BACKTEST_REQUEST.position_size
  );
  const [feeRate, setFeeRate] = React.useState(
    initialDetail?.request.fee_rate ?? DEFAULT_BACKTEST_REQUEST.fee_rate
  );

  const [runs, setRuns] = React.useState<BacktestRun[]>(initialRuns);
  const [activeRun, setActiveRun] = React.useState<BacktestDetail | null>(initialDetail);
  const [candles, setCandles] = React.useState<Candle[]>(initialCandles);
  const [activeTab, setActiveTab] = React.useState<"fills" | "equity" | "meta">("fills");
  const [running, setRunning] = React.useState(false);
  const [pollingRunId, setPollingRunId] = React.useState<string | null>(null);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(
    backendUnavailable
      ? "Private FastAPI backend is currently unreachable. Start the backend service and refresh."
      : initialDetail?.status === "failed"
      ? initialDetail.error ?? "Backtest execution failed."
      : null
  );
  const [fieldIssues, setFieldIssues] = React.useState<ContractIssue[]>([]);

  const pollAbortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    return () => {
      pollAbortRef.current?.abort();
    };
  }, []);

  const loadCandlesForRun = React.useCallback(
    async (run: BacktestDetail, signal?: AbortSignal) => {
      const symbol = encodeURIComponent(run.request.symbol);
      const iv = encodeURIComponent(run.request.interval);
      const res = await fetch(`/api/candles?symbol=${symbol}&interval=${iv}&limit=200`, {
        cache: "no-store",
        signal,
      });
      if (res.status === 401) {
        router.refresh();
        return;
      }
      if (!res.ok) return;
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        candles?: Candle[];
      };
      if (payload.ok && Array.isArray(payload.candles)) {
        setCandles(payload.candles);
      }
    },
    [router]
  );

  const refreshRunsList = React.useCallback(
    async (signal?: AbortSignal) => {
      const res = await fetch("/api/runs?limit=20", { cache: "no-store", signal });
      if (res.status === 401) {
        router.refresh();
        return;
      }
      if (!res.ok) return;
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        runs?: BacktestRun[];
      };
      if (payload.ok && Array.isArray(payload.runs)) {
        setRuns(payload.runs);
      }
    },
    [router]
  );

  const pollRunUntilTerminal = React.useCallback(
    async (runId: string) => {
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;
      setPollingRunId(runId);

      const startedAt = Date.now();
      let delayMs = POLL_INITIAL_DELAY_MS;

      try {
        for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1) {
          if (Date.now() - startedAt > POLL_MAX_ELAPSED_MS) {
            setErrorMessage(
              "Backtest is still queued/running. Select it from Recent Runs to check again."
            );
            return;
          }

          await sleep(delayMs, controller.signal);
          delayMs = Math.min(POLL_MAX_DELAY_MS, Math.round(delayMs * 1.5));

          const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (res.status === 401) {
            router.refresh();
            return;
          }
          const payload = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            run?: BacktestDetail;
            error?: string;
          };
          if (!res.ok || !payload.ok || !payload.run) {
            setErrorMessage(payload.error ?? "Failed to fetch backtest status.");
            return;
          }

          const detail = payload.run;
          setActiveRun(detail);
          setRuns((prev) =>
            prev.map((r) => (r.id === detail.id ? { ...r, status: detail.status } : r))
          );

          if (detail.status === "succeeded") {
            await Promise.all([
              loadCandlesForRun(detail, controller.signal),
              refreshRunsList(controller.signal),
            ]);
            return;
          }
          if (detail.status === "failed") {
            setCandles([]);
            setErrorMessage(detail.error ?? "Backtest execution failed.");
            await refreshRunsList(controller.signal);
            return;
          }
        }

        setErrorMessage(
          "Backtest did not finish within the polling limit. Select it from Recent Runs to refresh."
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setErrorMessage("Network error while polling backtest status.");
      } finally {
        if (pollAbortRef.current === controller) {
          setPollingRunId(null);
        }
      }
    },
    [loadCandlesForRun, refreshRunsList, router]
  );

  async function handleRunBacktest(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);
    setFieldIssues([]);

    const check = validateBacktestRequest({
      symbol: "SYNTH",
      interval,
      starting_capital: startingCapital.trim(),
      position_size: positionSize.trim(),
      fee_rate: feeRate.trim(),
    });
    if (!check.valid || !check.request) {
      setFieldIssues(check.issues);
      return;
    }

    pollAbortRef.current?.abort();
    setRunning(true);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(check.request),
      });

      if (response.status === 401) {
        router.refresh();
        return;
      }

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        run?: BacktestRun;
        error?: string;
        errors?: ContractIssue[];
      };

      if (!response.ok || !payload.ok || !payload.run) {
        if (payload.errors) {
          setFieldIssues(payload.errors);
        }
        setErrorMessage(payload.error ?? "Backtest submission failed.");
        return;
      }

      const created = payload.run;
      const stubDetail: BacktestDetail = {
        ...created,
        result: null,
        error: null,
      };
      setActiveRun(stubDetail);
      setCandles([]);
      setRuns((prev) => [created, ...prev.filter((r) => r.id !== created.id)].slice(0, 20));

      if (created.status === "queued" || created.status === "running") {
        void pollRunUntilTerminal(created.id);
      } else {
        await handleSelectRun(created.id);
      }
    } catch {
      setErrorMessage("Network error while submitting backtest.");
    } finally {
      setRunning(false);
    }
  }

  async function handleSelectRun(runId: string) {
    setErrorMessage(null);
    pollAbortRef.current?.abort();

    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
        cache: "no-store",
      });
      if (response.status === 401) {
        router.refresh();
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        run?: BacktestDetail;
        error?: string;
      };
      if (!response.ok || !payload.ok || !payload.run) {
        setErrorMessage(payload.error ?? "Could not load run detail.");
        return;
      }

      const detail = payload.run;
      setActiveRun(detail);
      setInterval(detail.request.interval);
      setStartingCapital(detail.request.starting_capital);
      setPositionSize(detail.request.position_size);
      setFeeRate(detail.request.fee_rate);

      if (detail.status === "succeeded") {
        await loadCandlesForRun(detail);
      } else if (detail.status === "queued" || detail.status === "running") {
        setCandles([]);
        void pollRunUntilTerminal(detail.id);
      } else if (detail.status === "failed") {
        setCandles([]);
        setErrorMessage(detail.error ?? "Backtest execution failed.");
      }
    } catch {
      setErrorMessage("Network error while loading run.");
    }
  }

  async function handleLogout() {
    pollAbortRef.current?.abort();
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.refresh();
    } finally {
      setLoggingOut(false);
    }
  }

  function handleResetDefaults() {
    setInterval(DEFAULT_BACKTEST_REQUEST.interval);
    setStartingCapital(DEFAULT_BACKTEST_REQUEST.starting_capital);
    setPositionSize(DEFAULT_BACKTEST_REQUEST.position_size);
    setFeeRate(DEFAULT_BACKTEST_REQUEST.fee_rate);
    setFieldIssues([]);
    setErrorMessage(null);
  }

  const summary = activeRun?.result?.summary ?? null;
  const fills = activeRun?.result?.fills ?? [];
  const equityCurve = activeRun?.result?.equity_curve ?? [];
  const activeSymbol = activeRun?.request.symbol ?? "SYNTH";
  const activeInterval = activeRun?.request.interval ?? interval;
  const activeCapital = activeRun?.request.starting_capital ?? startingCapital;

  const netPnlPositive = summary ? !summary.net_pnl.startsWith("-") : true;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <h1 className="font-serif text-xl font-semibold tracking-tight text-[var(--text)]">
              QuantTrading
            </h1>
            <Badge variant="default">Synthetic Only</Badge>
            <Badge variant="default">{CONTRACT_VERSION}</Badge>
          </div>
          <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1.5 font-mono">
              <ShieldCheck className="h-3.5 w-3.5 text-[var(--accent)]" />
              {user.username}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
              disabled={loggingOut}
            >
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1440px] grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-12">
        <aside className="space-y-6 lg:col-span-4 xl:col-span-3">
          <Card>
            <CardHeader>
              <CardTitle>Backtest Parameters</CardTitle>
              <CardDescription>
                Bundled synthetic fixture ({activeSymbol}). No live exchange execution.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleRunBacktest} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    Interval
                  </label>
                  <div className="grid grid-cols-2 gap-1 rounded-sm border border-[var(--border)] bg-[var(--surface-2)] p-0.5 text-xs">
                    {(["1d", "15m"] as const).map((iv) => (
                      <button
                        key={iv}
                        type="button"
                        onClick={() => setInterval(iv)}
                        className={`rounded-sm px-2.5 py-1.5 font-mono font-medium transition-colors ${
                          interval === iv
                            ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                            : "text-[var(--text-muted)] hover:text-[var(--text)]"
                        }`}
                      >
                        {iv === "1d" ? "1d (fixture)" : "15m (synth)"}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="starting_capital"
                    className="block text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]"
                  >
                    Starting Capital
                  </label>
                  <Input
                    id="starting_capital"
                    value={startingCapital}
                    onChange={(e) => setStartingCapital(e.target.value)}
                    className="font-mono"
                    inputMode="decimal"
                    required
                  />
                  <p className="text-[11px] text-[var(--text-muted)]">
                    &gt; 0 to 1,000,000,000.00 (max 2 decimals)
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="position_size"
                    className="block text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]"
                  >
                    Position Size (units)
                  </label>
                  <Input
                    id="position_size"
                    value={positionSize}
                    onChange={(e) => setPositionSize(e.target.value)}
                    className="font-mono"
                    inputMode="numeric"
                    required
                  />
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Integer 1 through 1,000,000
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="fee_rate"
                    className="block text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]"
                  >
                    Fee Rate
                  </label>
                  <Input
                    id="fee_rate"
                    value={feeRate}
                    onChange={(e) => setFeeRate(e.target.value)}
                    className="font-mono"
                    inputMode="decimal"
                    required
                  />
                  <p className="text-[11px] text-[var(--text-muted)]">
                    0 through 0.01 inclusive (max 8 decimals)
                  </p>
                </div>

                {fieldIssues.length > 0 ? (
                  <div
                    role="alert"
                    className="space-y-1 rounded-sm border border-[var(--negative)]/30 bg-[var(--negative-bg)] px-3 py-2 text-xs text-[var(--negative)]"
                  >
                    {fieldIssues.map((issue, idx) => (
                      <div key={`${issue.column}-${idx}`}>
                        <span className="font-mono font-semibold">{issue.column}</span>:{" "}
                        {issue.message}
                      </div>
                    ))}
                  </div>
                ) : null}

                {errorMessage ? (
                  <div
                    role="alert"
                    className="rounded-sm border border-[var(--negative)]/30 bg-[var(--negative-bg)] px-3 py-2 text-xs text-[var(--negative)]"
                  >
                    {errorMessage}
                  </div>
                ) : null}

                <div className="flex items-center gap-2 pt-1">
                  <Button type="submit" className="flex-1" disabled={running}>
                    <Play className="mr-1.5 h-3.5 w-3.5" />
                    {running ? "Submitting..." : "Run Backtest"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleResetDefaults}
                    title="Reset to contract defaults"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex w-full items-center justify-between gap-2">
                <CardTitle>Recent Runs</CardTitle>
                <span className="font-mono text-xs text-[var(--text-muted)]">
                  {runs.length}
                </span>
              </div>
              <CardDescription>
                Persisted in PostgreSQL via private FastAPI backend.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {runs.length === 0 ? (
                <div className="px-5 py-6 text-center text-xs text-[var(--text-muted)]">
                  No runs recorded yet. Submit a backtest above.
                </div>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {runs.map((run) => {
                    const selected = activeRun?.id === run.id;
                    return (
                      <li key={run.id}>
                        <button
                          type="button"
                          onClick={() => handleSelectRun(run.id)}
                          className={`w-full px-5 py-3 text-left transition-colors hover:bg-[var(--surface-2)] ${
                            selected ? "bg-[var(--surface-2)]" : ""
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs font-medium text-[var(--text)]">
                              {run.request.symbol} · {run.request.interval} ·{" "}
                              {run.request.starting_capital}
                            </span>
                            <Badge variant={statusBadgeVariant(run.status)}>
                              {run.status}
                            </Badge>
                          </div>
                          <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                            <span className="font-mono">
                              qty {run.request.position_size} · fee {run.request.fee_rate}
                            </span>
                            <span className="inline-flex items-center gap-1 font-mono">
                              <Clock className="h-3 w-3" />
                              {run.created_at.slice(0, 19).replace("T", " ")}
                            </span>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </aside>

        <section className="space-y-6 lg:col-span-8 xl:col-span-9">
          {activeRun && (activeRun.status === "queued" || activeRun.status === "running") ? (
            <div className="flex items-center justify-between rounded-sm border border-[var(--warning)]/30 bg-[var(--warning-bg)] px-4 py-3 text-xs text-[var(--warning)]">
              <span className="inline-flex items-center gap-2 font-medium">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                Backtest {activeRun.id.slice(0, 8)} is {activeRun.status}
                {pollingRunId === activeRun.id ? " — polling for result..." : "."}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSelectRun(activeRun.id)}
              >
                Refresh now
              </Button>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card>
              <CardContent className="pt-4">
                <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Final Equity
                </div>
                <div className="mt-1 font-mono text-xl font-semibold text-[var(--text)]">
                  {summary ? summary.final_equity : "—"}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                  Start {activeCapital}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Net PnL
                </div>
                <div
                  className={`mt-1 font-mono text-xl font-semibold ${
                    summary
                      ? netPnlPositive
                        ? "text-[var(--positive)]"
                        : "text-[var(--negative)]"
                      : "text-[var(--text)]"
                  }`}
                >
                  {summary ? formatSigned(summary.net_pnl) : "—"}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                  Gross {summary ? formatSigned(summary.gross_pnl) : "—"}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Total Fees
                </div>
                <div className="mt-1 font-mono text-xl font-semibold text-[var(--text)]">
                  {summary ? summary.total_fees : "—"}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                  {summary ? `${summary.fills} simulated fills` : "No fills"}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Max Drawdown
                </div>
                <div
                  className="mt-1 font-mono text-xl font-semibold text-[var(--text)]"
                  title={summary ? `Raw fraction: ${summary.max_drawdown}` : undefined}
                >
                  {summary ? formatDrawdownPercent(summary.max_drawdown) : "—"}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                  {summary ? `${summary.bars} bars` : "—"}
                </div>
              </CardContent>
            </Card>
          </div>

          <TradingCharts
            candles={activeRun?.status === "succeeded" ? candles : []}
            symbol={activeSymbol}
            interval={activeInterval}
            fills={fills}
            equityCurve={equityCurve}
            startingCapital={activeCapital}
          />

          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-3">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-[var(--accent)]" />
                <CardTitle>Run Ledger</CardTitle>
              </div>
              <div className="flex items-center gap-1 rounded-sm border border-[var(--border)] bg-[var(--surface-2)] p-0.5 text-xs">
                {(["fills", "equity", "meta"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className={`rounded-sm px-2.5 py-1 font-medium capitalize transition-colors ${
                      activeTab === tab
                        ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                        : "text-[var(--text-muted)] hover:text-[var(--text)]"
                    }`}
                  >
                    {tab === "meta"
                      ? "Metadata"
                      : tab === "fills"
                      ? `Fills (${fills.length})`
                      : `Equity (${equityCurve.length})`}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {activeTab === "fills" ? (
                fills.length === 0 ? (
                  <div className="px-5 py-8 text-center text-xs text-[var(--text-muted)]">
                    No simulated fills for this run.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>Signal Time (UTC)</TableHead>
                        <TableHead>Fill Time (UTC)</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead className="text-right">Units</TableHead>
                        <TableHead className="text-right">Price</TableHead>
                        <TableHead className="text-right">Notional</TableHead>
                        <TableHead className="text-right">Fee</TableHead>
                        <TableHead className="text-right">Cash After</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fills.map((fill) => (
                        <TableRow key={fill.id}>
                          <TableCell className="font-mono text-xs">{fill.id}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {formatUtcSeconds(fill.signal_time, activeInterval === "15m")}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {formatUtcSeconds(fill.fill_time, activeInterval === "15m")}
                          </TableCell>
                          <TableCell>
                            <Badge variant={fill.side === "BUY" ? "positive" : "negative"}>
                              {fill.side}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {fill.units}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {fill.price}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {fill.notional}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {fill.fee}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {fill.cash_after}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              ) : activeTab === "equity" ? (
                equityCurve.length === 0 ? (
                  <div className="px-5 py-8 text-center text-xs text-[var(--text-muted)]">
                    No equity curve rows for this run.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time (UTC)</TableHead>
                        <TableHead className="text-right">Close</TableHead>
                        <TableHead className="text-right">Position</TableHead>
                        <TableHead className="text-right">Cash</TableHead>
                        <TableHead className="text-right">Equity</TableHead>
                        <TableHead className="text-right">Peak</TableHead>
                        <TableHead className="text-right">Drawdown</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {equityCurve.map((row) => (
                        <TableRow key={row.time}>
                          <TableCell className="font-mono text-xs">
                            {formatUtcSeconds(row.time, activeInterval === "15m")}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {row.close}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {row.position_units}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {row.cash}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs font-semibold">
                            {row.equity}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {row.peak}
                          </TableCell>
                          <TableCell
                            className="text-right font-mono text-xs"
                            title={`Raw fraction: ${row.drawdown}`}
                          >
                            {formatDrawdownPercent(row.drawdown)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              ) : (
                <div className="grid grid-cols-1 gap-3 px-5 py-4 text-xs sm:grid-cols-2">
                  <div>
                    <div className="text-[var(--text-muted)]">Contract</div>
                    <div className="font-mono">{summary?.contract_id ?? CONTRACT_VERSION}</div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)]">Run ID</div>
                    <div className="font-mono">{activeRun?.id ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)]">Input File</div>
                    <div className="font-mono">{summary?.input_file ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)]">Input SHA-256</div>
                    <div className="break-all font-mono">{summary?.input_sha256 ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)]">Final Position Units</div>
                    <div className="font-mono">{summary?.final_position_units ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)]">Drawdown Peak / Trough</div>
                    <div className="font-mono">
                      {formatUtcSeconds(summary?.max_drawdown_peak_time, activeInterval === "15m")}{" "}
                      →{" "}
                      {formatUtcSeconds(
                        summary?.max_drawdown_trough_time,
                        activeInterval === "15m"
                      )}
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    <div className="text-[var(--text-muted)]">Disclaimer</div>
                    <div>
                      {summary?.disclaimer ??
                        "Synthetic simulation only. Not investment advice or live trading."}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}
