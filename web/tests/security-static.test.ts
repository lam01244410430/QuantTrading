import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "..");

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("static security, licensing, and chart architecture invariants", () => {
  it("uses TradingView Lightweight Charts (not Recharts) and preserves Apache-2.0 NOTICE", () => {
    const pkg = JSON.parse(readFileSync(path.join(WEB_ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies["lightweight-charts"]).toBeDefined();
    expect(pkg.dependencies["recharts"]).toBeUndefined();

    const notices = readFileSync(path.join(WEB_ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("TradingView Lightweight Charts™");
    expect(notices).toContain("Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/");
    expect(notices).toContain("Apache");
  });

  it("never references NEXT_PUBLIC_ backend URLs or tokens in src/", () => {
    const srcFiles = walkFiles(path.join(WEB_ROOT, "src"));
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toMatch(/NEXT_PUBLIC_/);
    }
  });

  it("anchors chart fill markers to fill_time (never signal_time) and includes TradingView link", () => {
    const charts = readFileSync(
      path.join(WEB_ROOT, "src/components/trading-charts.tsx"),
      "utf8"
    );
    expect(charts).toContain("createSeriesMarkers");
    expect(charts).toContain("fill.fill_time");
    expect(charts).not.toContain("fill.signal_time");
    expect(charts).toContain("https://www.tradingview.com/");

    const login = readFileSync(
      path.join(WEB_ROOT, "src/components/login-form.tsx"),
      "utf8"
    );
    expect(login).toContain("https://www.tradingview.com/");
    expect(login).toContain('method="post"');
  });
});
