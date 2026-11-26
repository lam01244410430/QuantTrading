import { NextResponse } from "next/server";
import { loginAdmin, SESSION_COOKIE_NAME } from "@/lib/backend";
import { isSecureRequest, verifySameOrigin } from "@/lib/csrf";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function safeLoginError(status: number): string {
  if (status === 429) {
    return "Too many sign-in attempts. Please wait and try again.";
  }
  if (status === 401 || status === 422 || status === 400) {
    return "Invalid username or password.";
  }
  return "Authentication service is unavailable.";
}

export async function POST(request: Request) {
  const csrf = verifySameOrigin(request);
  if (!csrf.ok) {
    return NextResponse.json(
      { ok: false, error: csrf.reason },
      { status: 403, headers: NO_STORE_HEADERS }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid username or password." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ok: false, error: "Invalid username or password." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const { username, password } = body as Record<string, unknown>;
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    username.length === 0 ||
    password.length === 0
  ) {
    return NextResponse.json(
      { ok: false, error: "Username and password are required." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    null;

  const result = await loginAdmin(username, password, clientIp);

  // Never proxy raw upstream login 422/error bodies (could echo password/input)
  // and never return access_token in any JSON response.
  if (!result.ok || !result.data) {
    const status = result.status === 422 ? 401 : result.status;
    const headers: Record<string, string> = { ...NO_STORE_HEADERS };
    if (result.retryAfter) {
      headers["Retry-After"] = result.retryAfter;
    }
    return NextResponse.json(
      { ok: false, error: safeLoginError(result.status) },
      { status, headers }
    );
  }

  const token = result.data.access_token;
  if (!token || typeof result.data.expires_in !== "number") {
    return NextResponse.json(
      { ok: false, error: "Authentication service returned an invalid session." },
      { status: 502, headers: NO_STORE_HEADERS }
    );
  }

  const response = NextResponse.json(
    {
      ok: true,
      user: {
        username: result.data.user.username,
        role: result.data.user.role,
      },
    },
    { status: 200, headers: NO_STORE_HEADERS }
  );
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: result.data.expires_in,
  });
  return response;
}
