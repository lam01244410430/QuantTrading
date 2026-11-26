import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { logoutAdmin, SESSION_COOKIE_NAME } from "@/lib/backend";
import { isSecureRequest, verifySameOrigin } from "@/lib/csrf";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

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
  await logoutAdmin(token);

  const response = NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE_HEADERS });
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
