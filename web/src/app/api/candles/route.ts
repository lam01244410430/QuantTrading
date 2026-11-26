import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { fetchCandles, SESSION_COOKIE_NAME } from "@/lib/backend";
import { isSecureRequest } from "@/lib/csrf";
import type { Interval } from "@/lib/types";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

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
  const symbol = url.searchParams.get("symbol") ?? "SYNTH";
  const intervalRaw = url.searchParams.get("interval") ?? "1d";
  const interval: Interval = intervalRaw === "15m" ? "15m" : "1d";
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 200;

  const result = await fetchCandles(token, {
    symbol,
    interval,
    limit: Number.isFinite(limit) ? limit : 200,
  });

  if (result.status === 401) {
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

  if (!result.ok || !result.data) {
    return NextResponse.json(
      { ok: false, error: result.error ?? "Failed to load candles" },
      { status: result.status, headers: NO_STORE_HEADERS }
    );
  }

  return NextResponse.json(
    { ok: true, ...result.data },
    { status: 200, headers: NO_STORE_HEADERS }
  );
}
