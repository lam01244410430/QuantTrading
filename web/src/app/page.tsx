import { cookies } from "next/headers";
import {
  fetchCandles,
  fetchCurrentAdmin,
  getBacktestRun,
  listBacktestRuns,
  SESSION_COOKIE_NAME,
} from "@/lib/backend";
import { LoginForm } from "@/components/login-form";
import { DashboardClient } from "@/components/dashboard-client";
import type { BacktestDetail, BacktestRun, Candle } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  // Always verify session server-side against private FastAPI.
  // Never trust proxy identity headers (e.g. X-Forwarded-User).
  const { user } = await fetchCurrentAdmin(token);

  if (!user || !token) {
    return <LoginForm />;
  }

  let initialRuns: BacktestRun[] = [];
  let initialDetail: BacktestDetail | null = null;
  let initialCandles: Candle[] = [];
  let backendUnavailable = false;

  const runsRes = await listBacktestRuns(token, 20);
  if (runsRes.ok && runsRes.data) {
    initialRuns = runsRes.data.runs ?? [];
    if (initialRuns.length > 0) {
      const detailRes = await getBacktestRun(token, initialRuns[0].id);
      if (detailRes.ok && detailRes.data) {
        initialDetail = detailRes.data;
        if (initialDetail.status === "succeeded") {
          const candlesRes = await fetchCandles(token, {
            symbol: initialDetail.request.symbol,
            interval: initialDetail.request.interval,
            limit: 200,
          });
          if (candlesRes.ok && candlesRes.data) {
            initialCandles = candlesRes.data.candles ?? [];
          }
        }
      }
    }
  } else if (runsRes.status === 503) {
    backendUnavailable = true;
  }

  return (
    <DashboardClient
      user={user}
      initialRuns={initialRuns}
      initialDetail={initialDetail}
      initialCandles={initialCandles}
      backendUnavailable={backendUnavailable}
    />
  );
}
