import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKTEST_REQUEST,
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
