import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKTEST_REQUEST,
  formatDrawdownPercent,
  validateBacktestRequest,
} from "@/lib/contract";

describe("ohlc-signal/v2.1.1 parameter validation", () => {
  it("accepts contract default parameters and preserves decimal strings", () => {
    const res = validateBacktestRequest(DEFAULT_BACKTEST_REQUEST);
    expect(res.valid).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.request).toEqual({
      symbol: "SYNTH",
      interval: "1d",
      starting_capital: "10000.00",
      position_size: "50",
      fee_rate: "0.001",
    });
  });

  it("accepts 15m synthetic interval and boundary values", () => {
    const res = validateBacktestRequest({
      symbol: "SYNTH",
      interval: "15m",
      starting_capital: "1000000000.00",
      position_size: "1000000",
      fee_rate: "0.01",
    });
    expect(res.valid).toBe(true);
    expect(res.request?.interval).toBe("15m");

    const minRes = validateBacktestRequest({
      symbol: "SYNTH",
      interval: "1d",
      starting_capital: "0.01",
      position_size: "1",
      fee_rate: "0",
    });
    expect(minRes.valid).toBe(true);
  });

  it("rejects out-of-bounds capital, position size, fee rate, symbol, and interval", () => {
    expect(
      validateBacktestRequest({
        ...DEFAULT_BACKTEST_REQUEST,
        starting_capital: "0",
      }).valid
    ).toBe(false);

    expect(
      validateBacktestRequest({
        ...DEFAULT_BACKTEST_REQUEST,
        starting_capital: "1000000000.01",
      }).valid
    ).toBe(false);

    expect(
      validateBacktestRequest({
        ...DEFAULT_BACKTEST_REQUEST,
        starting_capital: "100.123",
      }).valid
    ).toBe(false);

    expect(
      validateBacktestRequest({
        ...DEFAULT_BACKTEST_REQUEST,
        position_size: "0",
      }).valid
    ).toBe(false);

    expect(
      validateBacktestRequest({
        ...DEFAULT_BACKTEST_REQUEST,
        position_size: "050",
      }).valid
    ).toBe(false);

    expect(
      validateBacktestRequest({
        ...DEFAULT_BACKTEST_REQUEST,
        position_size: "1000001",
      }).valid
    ).toBe(false);

    expect(
      validateBacktestRequest({
        ...DEFAULT_BACKTEST_REQUEST,
        fee_rate: "0.01000001",
      }).valid
    ).toBe(false);

    expect(
      validateBacktestRequest({
        ...DEFAULT_BACKTEST_REQUEST,
        fee_rate: "-0.001",
      }).valid
    ).toBe(false);

    expect(
      validateBacktestRequest({
        ...DEFAULT_BACKTEST_REQUEST,
        symbol: "BTCUSDT" as "SYNTH",
      }).valid
    ).toBe(false);

    expect(
      validateBacktestRequest({
        ...DEFAULT_BACKTEST_REQUEST,
        interval: "1h" as "1d",
      }).valid
    ).toBe(false);
  });
});

describe("formatDrawdownPercent", () => {
  it("formats canonical fixture max_drawdown fraction 0.004955 as 0.50%", () => {
    expect(formatDrawdownPercent("0.004955")).toBe("0.50%");
  });

  it("formats zero, rounding boundaries, and invalid values cleanly", () => {
    expect(formatDrawdownPercent("0")).toBe("0.00%");
    expect(formatDrawdownPercent("0.000000")).toBe("0.00%");
    expect(formatDrawdownPercent("0.00494")).toBe("0.49%");
    expect(formatDrawdownPercent("0.125")).toBe("12.50%");
    expect(formatDrawdownPercent("1")).toBe("100.00%");
    expect(formatDrawdownPercent(null)).toBe("—");
    expect(formatDrawdownPercent(undefined)).toBe("—");
    expect(formatDrawdownPercent("")).toBe("—");
    expect(formatDrawdownPercent("-0.01")).toBe("—");
  });
});
