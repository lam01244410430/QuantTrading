/**
 * Origin/Referer CSRF validation for mutating BFF routes.
 * Rejects cross-origin POST/PUT/PATCH/DELETE requests with HTTP 403.
 */
export function verifySameOrigin(request: Request): { ok: boolean; reason?: string } {
  const hostHeader =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim();

  if (!hostHeader) {
    return { ok: false, reason: "Missing Host header" };
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host.toLowerCase() !== hostHeader.toLowerCase()) {
        return { ok: false, reason: "Cross-origin request rejected" };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "Malformed Origin header" };
    }
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (refererUrl.host.toLowerCase() !== hostHeader.toLowerCase()) {
        return { ok: false, reason: "Cross-origin Referer rejected" };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "Malformed Referer header" };
    }
  }

  return { ok: false, reason: "Missing Origin or Referer header" };
}

export function isSecureRequest(request: Request): boolean {
  if (process.env.COOKIE_SECURE === "true") return true;
  if (process.env.COOKIE_SECURE === "false") return false;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}
