import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { fetchCurrentAdmin, SESSION_COOKIE_NAME } from "@/lib/backend";
import { isSecureRequest } from "@/lib/csrf";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const { user, unauthorized } = await fetchCurrentAdmin(token);
  if (!user) {
    const response = NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
    if (unauthorized) {
      response.cookies.set({
        name: SESSION_COOKIE_NAME,
        value: "",
        httpOnly: true,
        sameSite: "lax",
        secure: isSecureRequest(request),
        path: "/",
        maxAge: 0,
      });
    }
    return response;
  }
  return NextResponse.json({ ok: true, user }, { status: 200, headers: NO_STORE_HEADERS });
}
