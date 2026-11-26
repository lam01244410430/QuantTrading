import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getBacktestRun, SESSION_COOKIE_NAME } from "@/lib/backend";
import { isSecureRequest } from "@/lib/csrf";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  const { id } = await context.params;
  if (!id || id.length > 128) {
    return NextResponse.json(
      { ok: false, error: "Invalid run id" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const result = await getBacktestRun(token, id);
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
      { ok: false, error: result.error ?? "Run not found" },
      { status: result.status, headers: NO_STORE_HEADERS }
    );
  }

  return NextResponse.json(
    { ok: true, run: result.data },
    { status: 200, headers: NO_STORE_HEADERS }
  );
}
