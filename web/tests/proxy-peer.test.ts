import { afterEach, describe, expect, it } from "vitest";
import {
  extractXForwardedForHeaders,
  parseTrustedProxyCidrs,
  resolveClientPeer,
} from "../proxy-peer.mjs";
import { isSecureRequest, verifySameOrigin } from "@/lib/csrf";
import { getSocketPeer, isTrustedProxyRequest, runWithRequestPeer } from "@/lib/peer";

describe("web trusted proxy CIDR & X-Forwarded-For resolution (backend parity)", () => {
  const cases: Array<{
    name: string;
    peer: string;
    headers: string[];
    cidrs: string;
    expectedIp: string | null;
    expectedTrusted: boolean;
  }> = [
    {
      name: "empty QT_WEB_TRUSTED_PROXY_CIDRS ignores spoofed X-Forwarded-For",
      peer: "127.0.0.1",
      headers: ["192.0.2.3"],
      cidrs: "",
      expectedIp: "127.0.0.1",
      expectedTrusted: false,
    },
    {
      name: "untrusted peer ignores spoofed X-Forwarded-For even when other CIDRs are configured",
      peer: "198.51.100.42",
      headers: ["203.0.113.1"],
      cidrs: "172.30.0.11/32",
      expectedIp: "198.51.100.42",
      expectedTrusted: false,
    },
    {
      name: "trusted proxy picks rightmost untrusted hop in single XFF header",
      peer: "10.0.0.3",
      headers: ["192.0.2.3, 198.51.100.9, 10.1.0.2"],
      cidrs: "10.0.0.0/8",
      expectedIp: "198.51.100.9",
      expectedTrusted: true,
    },
    {
      name: "trusted proxy picks rightmost untrusted hop across multiple XFF headers",
      peer: "10.0.0.3",
      headers: ["192.0.2.3", "198.51.100.9, 10.1.0.2"],
      cidrs: "10.0.0.0/8",
      expectedIp: "198.51.100.9",
      expectedTrusted: true,
    },
    {
      name: "trusted proxy fails closed on malformed rightmost hop",
      peer: "10.0.0.3",
      headers: ["198.51.100.9, not-an-ip"],
      cidrs: "10.0.0.0/8",
      expectedIp: null,
      expectedTrusted: true,
    },
    {
      name: "trusted proxy fails closed when all hops are trusted",
      peer: "10.0.0.3",
      headers: ["10.1.0.2"],
      cidrs: "10.0.0.0/8",
      expectedIp: null,
      expectedTrusted: true,
    },
    {
      name: "trusted proxy fails closed when XFF header is missing",
      peer: "172.30.0.11",
      headers: [],
      cidrs: "172.30.0.11/32",
      expectedIp: null,
      expectedTrusted: true,
    },
    {
      name: "bounded 2048-char tail handles oversized prefix in single header",
      peer: "10.0.0.3",
      headers: [`${"x".repeat(3000)}, 198.51.100.9, 10.1.0.2`],
      cidrs: "10.0.0.0/8",
      expectedIp: "198.51.100.9",
      expectedTrusted: true,
    },
    {
      name: "bounded 2048-char tail handles oversized earlier header",
      peer: "10.0.0.3",
      headers: ["x".repeat(3000), "198.51.100.9, 10.1.0.2"],
      cidrs: "10.0.0.0/8",
      expectedIp: "198.51.100.9",
      expectedTrusted: true,
    },
    {
      name: "bounded 2048-char tail fails closed when only trusted hop sits in tail",
      peer: "10.0.0.3",
      headers: [`${"x".repeat(3000)}, 10.1.0.2`],
      cidrs: "10.0.0.0/8",
      expectedIp: null,
      expectedTrusted: true,
    },
    {
      name: "IPv4-mapped IPv6 peer normalizes to IPv4 (untrusted)",
      peer: "::ffff:192.0.2.1",
      headers: [],
      cidrs: "",
      expectedIp: "192.0.2.1",
      expectedTrusted: false,
    },
    {
      name: "IPv4-mapped IPv6 peer matches IPv4 CIDR (Caddy over dual-stack socket)",
      peer: "::ffff:172.30.0.11",
      headers: ["203.0.113.55"],
      cidrs: "172.30.0.11/32",
      expectedIp: "203.0.113.55",
      expectedTrusted: true,
    },
    {
      name: "IPv4-mapped IPv6 CIDR normalizes to IPv4 CIDR",
      peer: "172.30.0.11",
      headers: ["203.0.113.56"],
      cidrs: "::ffff:172.30.0.0/120",
      expectedIp: "203.0.113.56",
      expectedTrusted: true,
    },
    {
      name: "native IPv6 trusted proxy resolves native IPv6 client",
      peer: "2001:db8::1",
      headers: ["2001:db8:abcd::42, 2001:db8::2"],
      cidrs: "2001:db8::/64",
      expectedIp: "2001:db8:abcd::42",
      expectedTrusted: true,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const trustedCidrs = parseTrustedProxyCidrs(c.cidrs);
      const resolved = resolveClientPeer({
        remoteAddress: c.peer,
        xForwardedForHeaders: c.headers,
        trustedCidrs,
      });
      expect(resolved).toEqual({
        clientPeerIp: c.expectedIp,
        fromTrustedProxy: c.expectedTrusted,
      });
    });
  }

  it("rejects invalid CIDR strings and host-bits-set CIDRs at startup", () => {
    expect(() => parseTrustedProxyCidrs("not-a-cidr")).toThrow();
    expect(() => parseTrustedProxyCidrs("10.0.0.1/8")).toThrow();
    expect(() => parseTrustedProxyCidrs("10.0.0.0/33")).toThrow();
    expect(parseTrustedProxyCidrs(" 172.30.0.11/32 , , 10.0.0.0/8 ")).toHaveLength(2);
  });

  it("extracts multiple wire X-Forwarded-For headers from rawHeaders in order", () => {
    const values = extractXForwardedForHeaders({
      rawHeaders: [
        "Host",
        "quant.example.com",
        "X-Forwarded-For",
        "198.51.100.1",
        "x-forwarded-for",
        "203.0.113.9, 172.30.0.11",
      ],
    });
    expect(values).toEqual(["198.51.100.1", "203.0.113.9, 172.30.0.11"]);
  });
});

describe("CSRF x-forwarded-host trust & COOKIE_SECURE", () => {
  const originalCookieSecure = process.env.COOKIE_SECURE;

  afterEach(() => {
    if (originalCookieSecure === undefined) {
      delete process.env.COOKIE_SECURE;
    } else {
      process.env.COOKIE_SECURE = originalCookieSecure;
    }
  });

  it("ignores spoofed x-forwarded-host when direct peer is NOT a trusted proxy", () => {
    const req = new Request("http://127.0.0.1:3000/api/auth/login", {
      method: "POST",
      headers: {
        host: "app.example.com",
        "x-forwarded-host": "evil.example",
        origin: "https://evil.example",
      },
    });

    const result = runWithRequestPeer(
      { clientPeerIp: "198.51.100.5", fromTrustedProxy: false },
      () => {
        expect(isTrustedProxyRequest()).toBe(false);
        expect(getSocketPeer()).toBe("198.51.100.5");
        return verifySameOrigin(req);
      }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Cross-origin request rejected");
  });

  it("trusts x-forwarded-host ONLY when direct peer IS a trusted proxy (e.g. Caddy)", () => {
    const req = new Request("http://web:3000/api/auth/login", {
      method: "POST",
      headers: {
        host: "web:3000",
        "x-forwarded-host": "quant.example.com",
        "x-forwarded-proto": "https",
        origin: "https://quant.example.com",
      },
    });

    const result = runWithRequestPeer(
      { clientPeerIp: "203.0.113.9", fromTrustedProxy: true },
      () => {
        expect(isTrustedProxyRequest()).toBe(true);
        expect(getSocketPeer()).toBe("203.0.113.9");
        return verifySameOrigin(req);
      }
    );

    expect(result).toEqual({ ok: true });

    const crossOriginViaProxy = new Request("http://web:3000/api/auth/login", {
      method: "POST",
      headers: {
        host: "web:3000",
        "x-forwarded-host": "quant.example.com",
        origin: "https://attacker.example",
      },
    });

    const rejected = runWithRequestPeer(
      { clientPeerIp: "203.0.113.9", fromTrustedProxy: true },
      () => verifySameOrigin(crossOriginViaProxy)
    );
    expect(rejected.ok).toBe(false);
  });

  it("enforces COOKIE_SECURE=true unconditionally and restricts x-forwarded-proto to trusted proxies", () => {
    delete process.env.COOKIE_SECURE;

    const httpWithSpoofedProto = new Request("http://127.0.0.1:3000/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
    });

    expect(
      runWithRequestPeer(
        { clientPeerIp: "198.51.100.5", fromTrustedProxy: false },
        () => isSecureRequest(httpWithSpoofedProto)
      )
    ).toBe(false);

    expect(
      runWithRequestPeer(
        { clientPeerIp: "203.0.113.9", fromTrustedProxy: true },
        () => isSecureRequest(httpWithSpoofedProto)
      )
    ).toBe(true);

    process.env.COOKIE_SECURE = "true";
    const plainHttp = new Request("http://web:3000/api/auth/login", {
      method: "POST",
    });
    expect(
      runWithRequestPeer(
        { clientPeerIp: "198.51.100.5", fromTrustedProxy: false },
        () => isSecureRequest(plainHttp)
      )
    ).toBe(true);
  });
});
