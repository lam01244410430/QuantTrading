import type {
  AuthUser,
  BacktestDetail,
  BacktestRequest,
  BacktestRun,
  CandleList,
  Interval,
} from "./types";

export const SESSION_COOKIE_NAME = "qt_session";

const DEFAULT_API_URL = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 15_000;

export function getApiBaseUrl(): string {
  const raw =
    process.env.QUANTTRADING_API_URL?.trim() ||
    process.env.BACKEND_INTERNAL_URL?.trim() ||
    DEFAULT_API_URL;
  return raw.replace(/\/+$/, "");
}

export interface BackendResult<T> {
  status: number;
  ok: boolean;
  data?: T;
  error?: string;
  retryAfter?: string | null;
}

export async function backendFetch<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    sessionToken?: string | null;
    body?: unknown;
    clientIp?: string | null;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<BackendResult<T>> {
  const fetchFn = options.fetchImpl ?? fetch;
  const url = `${getApiBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.sessionToken) {
    headers["Authorization"] = `Bearer ${options.sessionToken}`;
  }
  if (options.clientIp) {
    headers["X-Forwarded-For"] = options.clientIp;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchFn(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });

    const retryAfter = response.headers.get("retry-after");

    if (response.status === 204) {
      return { status: 204, ok: true, retryAfter };
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      return {
        status: response.status,
        ok: false,
        error:
          (typeof parsed?.detail === "string" && parsed.detail) ||
          (typeof parsed?.error === "string" && parsed.error) ||
          `Backend request failed (${response.status})`,
        retryAfter,
      };
    }

    return {
      status: response.status,
      ok: true,
      data: parsed as unknown as T,
      retryAfter,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      status: 503,
      ok: false,
      error: isAbort
        ? "Backend request timed out"
        : "Private backend service is unavailable",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCurrentAdmin(
  sessionToken: string | null | undefined,
  fetchImpl?: typeof fetch
): Promise<{ user: AuthUser | null; unauthorized: boolean }> {
  if (!sessionToken) return { user: null, unauthorized: false };
  const res = await backendFetch<AuthUser>("/api/v1/auth/me", {
    sessionToken,
    fetchImpl,
  });
  if (res.status === 401) {
    return { user: null, unauthorized: true };
  }
  if (!res.ok || !res.data?.username) {
    return { user: null, unauthorized: false };
  }
  return {
    user: { username: res.data.username, role: res.data.role ?? "admin" },
    unauthorized: false,
  };
}

export async function loginAdmin(
  username: string,
  password: string,
  clientIp?: string | null,
  fetchImpl?: typeof fetch
): Promise<
  BackendResult<{
    access_token: string;
    token_type: "bearer";
    expires_in: number;
    user: AuthUser;
  }>
> {
  return backendFetch("/api/v1/auth/login", {
    method: "POST",
    body: { username, password },
    clientIp,
    fetchImpl,
  });
}

export async function logoutAdmin(
  sessionToken: string | null | undefined,
  fetchImpl?: typeof fetch
): Promise<BackendResult<void>> {
  if (!sessionToken) return { status: 204, ok: true };
  return backendFetch("/api/v1/auth/logout", {
    method: "POST",
    sessionToken,
    fetchImpl,
  });
}

export async function listBacktestRuns(
  sessionToken: string,
  limit = 20,
  fetchImpl?: typeof fetch
): Promise<BackendResult<{ runs: BacktestRun[] }>> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return backendFetch(`/api/v1/backtests?limit=${safeLimit}`, {
    sessionToken,
    fetchImpl,
  });
}

export async function createBacktestRun(
  sessionToken: string,
  req: BacktestRequest,
  fetchImpl?: typeof fetch
): Promise<BackendResult<BacktestRun>> {
  return backendFetch("/api/v1/backtests", {
    method: "POST",
    sessionToken,
    body: req,
    fetchImpl,
  });
}

export async function getBacktestRun(
  sessionToken: string,
  runId: string,
  fetchImpl?: typeof fetch
): Promise<BackendResult<BacktestDetail>> {
  const safeId = encodeURIComponent(runId);
  return backendFetch(`/api/v1/backtests/${safeId}`, { sessionToken, fetchImpl });
}

export async function fetchCandles(
  sessionToken: string,
  query: { symbol?: string; interval?: Interval; limit?: number } = {},
  fetchImpl?: typeof fetch
): Promise<BackendResult<CandleList>> {
  const params = new URLSearchParams();
  if (query.symbol) params.set("symbol", query.symbol);
  if (query.interval) params.set("interval", query.interval);
  if (query.limit) {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(query.limit)));
    params.set("limit", String(safeLimit));
  }
  const qs = params.toString();
  return backendFetch(`/api/v1/candles${qs ? `?${qs}` : ""}`, {
    sessionToken,
    fetchImpl,
  });
}
