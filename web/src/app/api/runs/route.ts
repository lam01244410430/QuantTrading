import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  createBacktestRun,
  listBacktestRuns,
  SESSION_COOKIE_NAME,
} from "@/lib/backend";
import { validateBacktestRequest } from "@/lib/contract";
import { isSecureRequest, verifySameOrigin } from "@/lib/csrf";
import type { Interval } from "@/lib/types";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function unauthorizedResponse(request: Request) {
  const response = NextResponse.json(
    { ok: false, error: "Unauthorized" },
    { status: 401, headers: NO_STORE_HEADERS }
  );
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 20;

  const result = await listBacktestRuns(token, Number.isFinite(limit) ? limit : 20);
  if (result.status === 401) {
    return unauthorizedResponse(request);
  }
  if (!result.ok || !result.data) {
    return NextResponse.json(
      { ok: false, error: result.error ?? "Failed to load runs" },
      { status: result.status, headers: NO_STORE_HEADERS }
    );
  }

  return NextResponse.json(
    { ok: true, runs: result.data.runs ?? [] },
    { status: 200, headers: NO_STORE_HEADERS }
  );
}

export async function POST(request: Request) {
  const csrf = verifySameOrigin(request);
  if (!csrf.ok) {
    return NextResponse.json(
      { ok: false, error: csrf.reason },
      { status: 403, headers: NO_STORE_HEADERS }
    );
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be valid JSON" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ok: false, error: "Request body must be a JSON object" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const raw = body as Record<string, unknown>;
  const validation = validateBacktestRequest({
    symbol: typeof raw.symbol === "string" ? (raw.symbol as "SYNTH") : "SYNTH",
    interval: typeof raw.interval === "string" ? (raw.interval as Interval) : "1d",
    starting_capital:
      typeof raw.starting_capital === "string" ? raw.starting_capital : undefined,
    position_size: typeof raw.position_size === "string" ? raw.position_size : undefined,
    fee_rate: typeof raw.fee_rate === "string" ? raw.fee_rate : undefined,
  });

  if (!validation.valid || !validation.request) {
    return NextResponse.json(
      {
        ok: false,
        error: "Invalid backtest parameters",
        errors: validation.issues,
      },
      { status: 422, headers: NO_STORE_HEADERS }
    );
  }

  const result = await createBacktestRun(token, validation.request);
  if (result.status === 401) {
    return unauthorizedResponse(request);
  }
  if (!result.ok || !result.data) {
    return NextResponse.json(
      { ok: false, error: result.error ?? "Backtest enqueue failed" },
      { status: result.status, headers: NO_STORE_HEADERS }
    );
  }

  return NextResponse.json(
    { ok: true, run: result.data },
    { status: result.status, headers: NO_STORE_HEADERS }
  );
}
