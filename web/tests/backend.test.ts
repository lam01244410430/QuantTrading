import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBacktestRun,
  fetchCandles,
  fetchCurrentAdmin,
  getApiBaseUrl,
  getBacktestRun,
  listBacktestRuns,
  loginAdmin,
  logoutAdmin,
} from "@/lib/backend";
import { DEFAULT_BACKTEST_REQUEST } from "@/lib/contract";

describe("backend client (API contract v0.1.0)", () => {
  const originalEnv = process.env.QUANTTRADING_API_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.QUANTTRADING_API_URL;
    } else {
      process.env.QUANTTRADING_API_URL = originalEnv;
    }
  });

  it("reads QUANTTRADING_API_URL and strips trailing slash", () => {
    process.env.QUANTTRADING_API_URL = "http://api.internal:8000/";
    expect(getApiBaseUrl()).toBe("http://api.internal:8000");
  });

  it("sends Authorization: Bearer and calls exact v0.1.0 paths", async () => {
    process.env.QUANTTRADING_API_URL = "http://api.internal:8000";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/v1/auth/logout")) {
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/api/v1/auth/me")) {
        return new Response(JSON.stringify({ username: "admin", role: "admin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).endsWith("/api/v1/auth/login")) {
        return new Response(
          JSON.stringify({
            access_token: "jwt-secret-token",
            token_type: "bearer",
            expires_in: 28800,
            user: { username: "admin", role: "admin" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (String(url).includes("/api/v1/candles")) {
        return new Response(
          JSON.stringify({ symbol: "SYNTH", interval: "1d", candles: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (String(url).includes("/api/v1/backtests/run-1")) {
        return new Response(
          JSON.stringify({
            id: "run-1",
            status: "succeeded",
            created_at: "2026-11-26T00:00:00Z",
            request: DEFAULT_BACKTEST_REQUEST,
            result: null,
            error: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (String(url).includes("/api/v1/backtests")) {
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({
              id: "run-1",
              status: "queued",
              created_at: "2026-11-26T00:00:00Z",
              request: DEFAULT_BACKTEST_REQUEST,
            }),
            { status: 202, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ runs: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const loginRes = await loginAdmin("admin", "pw", "127.0.0.1", mockFetch);
    expect(loginRes.ok).toBe(true);
    expect(loginRes.data?.access_token).toBe("jwt-secret-token");

    const me = await fetchCurrentAdmin("jwt-secret-token", mockFetch);
    expect(me).toEqual({ user: { username: "admin", role: "admin" }, unauthorized: false });

    const created = await createBacktestRun(
      "jwt-secret-token",
      DEFAULT_BACKTEST_REQUEST,
      mockFetch
    );
    expect(created.status).toBe(202);

    const list = await listBacktestRuns("jwt-secret-token", 20, mockFetch);
    expect(list.ok).toBe(true);

    const detail = await getBacktestRun("jwt-secret-token", "run-1", mockFetch);
    expect(detail.ok).toBe(true);

    const candles = await fetchCandles(
      "jwt-secret-token",
      { symbol: "SYNTH", interval: "1d", limit: 200 },
      mockFetch
    );
    expect(candles.ok).toBe(true);

    const logout = await logoutAdmin("jwt-secret-token", mockFetch);
    expect(logout.status).toBe(204);

    expect(calls.map((c) => c.url)).toEqual([
      "http://api.internal:8000/api/v1/auth/login",
      "http://api.internal:8000/api/v1/auth/me",
      "http://api.internal:8000/api/v1/backtests",
      "http://api.internal:8000/api/v1/backtests?limit=20",
      "http://api.internal:8000/api/v1/backtests/run-1",
      "http://api.internal:8000/api/v1/candles?symbol=SYNTH&interval=1d&limit=200",
      "http://api.internal:8000/api/v1/auth/logout",
    ]);

    // Authenticated calls send Authorization: Bearer
    const authHeaders = calls[1].init?.headers as Record<string, string>;
    expect(authHeaders["Authorization"]).toBe("Bearer jwt-secret-token");
    expect(calls[1].init?.cache).toBe("no-store");
  });
});
