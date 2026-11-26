import { describe, expect, it } from "vitest";
import { isSecureRequest, verifySameOrigin } from "@/lib/csrf";

describe("CSRF same-origin & secure request checks", () => {
  it("accepts matching Origin header", () => {
    const req = new Request("http://localhost:3000/api/runs", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
      },
    });
    expect(verifySameOrigin(req)).toEqual({ ok: true });
  });

  it("accepts matching Referer when Origin is absent", () => {
    const req = new Request("https://app.example.com/api/auth/logout", {
      method: "POST",
      headers: {
        "x-forwarded-host": "app.example.com",
        referer: "https://app.example.com/",
      },
    });
    expect(verifySameOrigin(req)).toEqual({ ok: true });
  });

  it("rejects cross-origin Origin", () => {
    const req = new Request("https://app.example.com/api/runs", {
      method: "POST",
      headers: {
        host: "app.example.com",
        origin: "https://evil.example.net",
      },
    });
    expect(verifySameOrigin(req).ok).toBe(false);
  });

  it("rejects missing Origin and Referer", () => {
    const req = new Request("https://app.example.com/api/runs", {
      method: "POST",
      headers: { host: "app.example.com" },
    });
    expect(verifySameOrigin(req).ok).toBe(false);
  });

  it("detects TLS via x-forwarded-proto or https URL", () => {
    const proxiedHttps = new Request("http://127.0.0.1:3000/api/auth/login", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(isSecureRequest(proxiedHttps)).toBe(true);

    const plainHttp = new Request("http://127.0.0.1:3000/api/auth/login");
    expect(isSecureRequest(plainHttp)).toBe(false);
  });
});
