import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME } from "@/lib/backend";
import { runWithSocketPeer } from "@/lib/peer";

let mockedCookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE_NAME && mockedCookieValue !== undefined
        ? { name, value: mockedCookieValue }
        : undefined,
  })),
}));

import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { GET as meGet } from "@/app/api/auth/me/route";
import { GET as runsGet, POST as runsPost } from "@/app/api/runs/route";
import { GET as runDetailGet } from "@/app/api/runs/[id]/route";
import { GET as candlesGet } from "@/app/api/candles/route";
import { GET as healthGet } from "@/app/api/health/route";

const SAME_ORIGIN_HEADERS = {
  host: "app.example.com",
  origin: "https://app.example.com",
  "x-forwarded-proto": "https",
  "content-type": "application/json",
};

describe("BFF route handlers security, auth, and contract parity", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockedCookieValue = undefined;
    process.env.QUANTTRADING_API_URL = "http://127.0.0.1:8000";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("health route reports layer-1-bff and ohlc-signal/v2.1.1", async () => {
    const res = await healthGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      layer: "layer-1-bff",
      contract_version: "ohlc-signal/v2.1.1",
    });
  });

  it("login sets HttpOnly SameSite=lax Secure cookie with expires_in and NEVER leaks access_token in JSON", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "super-secret-jwt-value",
          token_type: "bearer",
          expires_in: 28800,
          user: { username: "admin", role: "admin" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const req = new Request("https://app.example.com/api/auth/login", {
      method: "POST",
      headers: SAME_ORIGIN_HEADERS,
      body: JSON.stringify({ username: "admin", password: "correct-horse-battery" }),
    });

    const res = await loginPost(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const text = await res.text();
    expect(text).not.toContain("super-secret-jwt-value");
    expect(text).not.toContain("access_token");
    expect(JSON.parse(text)).toEqual({
      ok: true,
      user: { username: "admin", role: "admin" },
    });

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=super-secret-jwt-value`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Max-Age=28800");
  });

  it("login forwards admin username verbatim including surrounding whitespace", async () => {
    let forwardedBody: string | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      forwardedBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response(
        JSON.stringify({
          access_token: "tok",
          token_type: "bearer",
          expires_in: 3600,
          user: { username: " admin ", role: "admin" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const req = new Request("https://app.example.com/api/auth/login", {
      method: "POST",
      headers: SAME_ORIGIN_HEADERS,
      body: JSON.stringify({ username: " admin ", password: "pw" }),
    });

    const res = await loginPost(req);
    expect(res.status).toBe(200);
    expect(JSON.parse(forwardedBody ?? "{}")).toEqual({
      username: " admin ",
      password: "pw",
    });
  });

  it("login NEVER proxies raw upstream 422 validation bodies (which could echo passwords)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          detail: [
            {
              loc: ["body", "password"],
              msg: "String should have at least 1 character",
              input: "leaked-password-fragment",
            },
          ],
        }),
        { status: 422, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const req = new Request("https://app.example.com/api/auth/login", {
      method: "POST",
      headers: SAME_ORIGIN_HEADERS,
      body: JSON.stringify({ username: "admin", password: "x" }),
    });

    const res = await loginPost(req);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("leaked-password-fragment");
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: "Invalid username or password.",
    });
  });

  it("login propagates 429 rate-limit status and Retry-After with safe error text", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "rate limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      })
    ) as unknown as typeof fetch;

    const req = new Request("https://app.example.com/api/auth/login", {
      method: "POST",
      headers: SAME_ORIGIN_HEADERS,
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });

    const res = await loginPost(req);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("login overwrites X-Forwarded-For with real socket peer and NEVER passes client headers through", async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ detail: "invalid" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // With a bound real socket peer (IPv4-mapped IPv6), X-Forwarded-For is overwritten
    // with the normalized real peer, completely ignoring spoofed incoming headers.
    const res1 = await runWithSocketPeer("::ffff:198.51.100.7", () =>
      loginPost(
        new Request("https://app.example.com/api/auth/login", {
          method: "POST",
          headers: {
            ...SAME_ORIGIN_HEADERS,
            "x-forwarded-for": "203.0.113.1, 10.0.0.1",
            "x-real-ip": "203.0.113.2",
          },
          body: JSON.stringify({ username: "admin", password: "wrong" }),
        })
      )
    );
    expect(res1.status).toBe(401);
    expect(seenHeaders[0]["X-Forwarded-For"]).toBe("198.51.100.7");

    // Without a bound socket peer (e.g. if started without server.mjs),
    // client-supplied X-Forwarded-For / X-Real-IP are still NEVER forwarded.
    const res2 = await loginPost(
      new Request("https://app.example.com/api/auth/login", {
        method: "POST",
        headers: {
          ...SAME_ORIGIN_HEADERS,
          "x-forwarded-for": "203.0.113.99",
          "x-real-ip": "203.0.113.99",
        },
        body: JSON.stringify({ username: "admin", password: "wrong" }),
      })
    );
    expect(res2.status).toBe(401);
    expect(seenHeaders[1]["X-Forwarded-For"]).toBeUndefined();
    expect(seenHeaders[1]["x-forwarded-for"]).toBeUndefined();
  });

  it("login propagates upstream 503 outage with no-store and safe error text", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "Login temporarily unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof fetch;

    const res = await runWithSocketPeer("198.51.100.10", () =>
      loginPost(
        new Request("https://app.example.com/api/auth/login", {
          method: "POST",
          headers: SAME_ORIGIN_HEADERS,
          body: JSON.stringify({ username: "admin", password: "wrong" }),
        })
      )
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: false,
      error: "Authentication service is unavailable.",
    });
  });

  it("rejects cross-origin POST on login, logout, and runs with 403", async () => {
    const crossHeaders = {
      host: "app.example.com",
      origin: "https://attacker.example",
      "content-type": "application/json",
    };

    const loginRes = await loginPost(
      new Request("https://app.example.com/api/auth/login", {
        method: "POST",
        headers: crossHeaders,
        body: JSON.stringify({ username: "admin", password: "pw" }),
      })
    );
    expect(loginRes.status).toBe(403);

    const logoutRes = await logoutPost(
      new Request("https://app.example.com/api/auth/logout", {
        method: "POST",
        headers: crossHeaders,
      })
    );
    expect(logoutRes.status).toBe(403);

    mockedCookieValue = "valid-token";
    const runsRes = await runsPost(
      new Request("https://app.example.com/api/runs", {
        method: "POST",
        headers: crossHeaders,
        body: JSON.stringify({
          symbol: "SYNTH",
          interval: "1d",
          starting_capital: "10000.00",
          position_size: "50",
          fee_rate: "0.001",
        }),
      })
    );
    expect(runsRes.status).toBe(403);
  });

  it("enforces server-side auth on all protected APIs and ignores X-Forwarded-User", async () => {
    const spoofedHeaders = {
      host: "app.example.com",
      origin: "https://app.example.com",
      "x-forwarded-user": "admin",
      "x-auth-request-user": "admin",
    };

    const meRes = await meGet(
      new Request("https://app.example.com/api/auth/me", { headers: spoofedHeaders })
    );
    expect(meRes.status).toBe(401);
    expect(meRes.headers.get("cache-control")).toBe("no-store");

    const runsRes = await runsGet(
      new Request("https://app.example.com/api/runs", { headers: spoofedHeaders })
    );
    expect(runsRes.status).toBe(401);
    expect(runsRes.headers.get("cache-control")).toBe("no-store");

    const postRes = await runsPost(
      new Request("https://app.example.com/api/runs", {
        method: "POST",
        headers: { ...spoofedHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          symbol: "SYNTH",
          interval: "1d",
          starting_capital: "10000.00",
          position_size: "50",
          fee_rate: "0.001",
        }),
      })
    );
    expect(postRes.status).toBe(401);

    const detailRes = await runDetailGet(
      new Request("https://app.example.com/api/runs/run-1", { headers: spoofedHeaders }),
      { params: Promise.resolve({ id: "run-1" }) }
    );
    expect(detailRes.status).toBe(401);

    const candlesRes = await candlesGet(
      new Request("https://app.example.com/api/candles?symbol=SYNTH&interval=1d", {
        headers: spoofedHeaders,
      })
    );
    expect(candlesRes.status).toBe(401);
  });

  it("clears qt_session cookie when upstream returns 401 (expired/revoked session)", async () => {
    mockedCookieValue = "expired-token";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "expired" }), { status: 401 })
    ) as unknown as typeof fetch;

    const res = await runDetailGet(
      new Request("https://app.example.com/api/runs/run-1", {
        headers: { "x-forwarded-proto": "https" },
      }),
      { params: Promise.resolve({ id: "run-1" }) }
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(setCookie).toContain("Max-Age=0");
  });

  it("handles async 202 backtest enqueue and default fixture parity detail with decimal strings", async () => {
    mockedCookieValue = "valid-token";
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/v1/backtests") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "11111111-1111-4111-8111-111111111111",
            status: "queued",
            created_at: "2026-11-26T08:00:00Z",
            request: {
              symbol: "SYNTH",
              interval: "1d",
              starting_capital: "10000.00",
              position_size: "50",
              fee_rate: "0.001",
            },
          }),
          { status: 202, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          status: "succeeded",
          created_at: "2026-11-26T08:00:00Z",
          request: {
            symbol: "SYNTH",
            interval: "1d",
            starting_capital: "10000.00",
            position_size: "50",
            fee_rate: "0.001",
          },
          result: {
            summary: {
              bars: 8,
              contract_id: "ohlc-signal/v2",
              disclaimer: "Simulated backtest only.",
              fills: 2,
              final_equity: "10199.77",
              final_position_units: "0",
              gross_pnl: "210.00",
              net_pnl: "199.77",
              total_fees: "10.23",
              max_drawdown: "50.00",
              max_drawdown_peak_time: 1704153600,
              max_drawdown_trough_time: 1704240000,
              input_file: "fixtures/fixture_v1_basic.csv",
              input_sha256: "abc123",
            },
            equity_curve: [
              {
                time: 1704067200,
                cash: "10000.00",
                position_units: "0",
                close: "100.00",
                equity: "10000.00",
                peak: "10000.00",
                drawdown: "0.00",
              },
            ],
            fills: [
              {
                id: 1,
                signal_time: 1704067200,
                fill_time: 1704153600,
                side: "BUY",
                units: "50",
                price: "100.50",
                notional: "5025.00",
                fee: "5.03",
                cash_after: "4969.97",
              },
            ],
          },
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const createRes = await runsPost(
      new Request("https://app.example.com/api/runs", {
        method: "POST",
        headers: SAME_ORIGIN_HEADERS,
        body: JSON.stringify({
          symbol: "SYNTH",
          interval: "1d",
          starting_capital: "10000.00",
          position_size: "50",
          fee_rate: "0.001",
        }),
      })
    );
    expect(createRes.status).toBe(202);
    expect(createRes.headers.get("cache-control")).toBe("no-store");
    const createdBody = await createRes.json();
    expect(createdBody.run.status).toBe("queued");

    const detailRes = await runDetailGet(
      new Request("https://app.example.com/api/runs/11111111-1111-4111-8111-111111111111"),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );
    expect(detailRes.status).toBe(200);
    expect(detailRes.headers.get("cache-control")).toBe("no-store");
    const detailBody = await detailRes.json();
    expect(detailBody.run.result.summary.final_equity).toBe("10199.77");
    expect(detailBody.run.result.summary.total_fees).toBe("10.23");
    expect(typeof detailBody.run.result.summary.final_equity).toBe("string");
    expect(detailBody.run.result.fills[0].fill_time).toBe(1704153600);
    expect(detailBody.run.result.fills[0].signal_time).toBe(1704067200);
  });

  it("POST /api/runs accepts {} and partial bodies by applying ohlc-signal/v2.1.1 defaults, while still rejecting invalid bounds", async () => {
    mockedCookieValue = "valid-token";
    const forwardedBodies: unknown[] = [];

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      forwardedBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          id: "22222222-2222-4222-8222-222222222222",
          status: "queued",
          created_at: "2026-01-10T00:00:00Z",
          request: forwardedBodies[forwardedBodies.length - 1],
        }),
        { status: 202, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const emptyRes = await runsPost(
      new Request("https://app.example.com/api/runs", {
        method: "POST",
        headers: SAME_ORIGIN_HEADERS,
        body: JSON.stringify({}),
      })
    );
    expect(emptyRes.status).toBe(202);
    expect(emptyRes.headers.get("cache-control")).toBe("no-store");
    expect(forwardedBodies[0]).toEqual({
      symbol: "SYNTH",
      interval: "1d",
      starting_capital: "10000.00",
      position_size: "50",
      fee_rate: "0.001",
    });

    const partialRes = await runsPost(
      new Request("https://app.example.com/api/runs", {
        method: "POST",
        headers: SAME_ORIGIN_HEADERS,
        body: JSON.stringify({ interval: "15m" }),
      })
    );
    expect(partialRes.status).toBe(202);
    expect(forwardedBodies[1]).toEqual({
      symbol: "SYNTH",
      interval: "15m",
      starting_capital: "10000.00",
      position_size: "50",
      fee_rate: "0.001",
    });

    const badBoundsRes = await runsPost(
      new Request("https://app.example.com/api/runs", {
        method: "POST",
        headers: SAME_ORIGIN_HEADERS,
        body: JSON.stringify({ starting_capital: "0" }),
      })
    );
    expect(badBoundsRes.status).toBe(422);

    const nullFieldRes = await runsPost(
      new Request("https://app.example.com/api/runs", {
        method: "POST",
        headers: SAME_ORIGIN_HEADERS,
        body: JSON.stringify({ symbol: null }),
      })
    );
    expect(nullFieldRes.status).toBe(422);

    const extraFieldRes = await runsPost(
      new Request("https://app.example.com/api/runs", {
        method: "POST",
        headers: SAME_ORIGIN_HEADERS,
        body: JSON.stringify({ unexpected: "1" }),
      })
    );
    expect(extraFieldRes.status).toBe(422);
    expect(forwardedBodies).toHaveLength(2);
  });
});
