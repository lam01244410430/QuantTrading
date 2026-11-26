import type { BacktestRequest, ContractIssue, Interval } from "./types";

export const CONTRACT_VERSION = "ohlc-signal/v2.1.1";
export const API_CONTRACT_VERSION = "0.1.0";

export const DEFAULT_BACKTEST_REQUEST: BacktestRequest = {
  symbol: "SYNTH",
  interval: "1d",
  starting_capital: "10000.00",
  position_size: "50",
  fee_rate: "0.001",
};

const CAPITAL_RE = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;
const SIZE_RE = /^[1-9][0-9]{0,6}$/;
const FEE_RE = /^[0-9]{1,2}(\.[0-9]{1,8})?$/;
const VALID_INTERVALS: ReadonlySet<string> = new Set<Interval>(["1d", "15m"]);

function parseScaledDecimal(value: string, scale: number): bigint {
  const [intPart, fracPart = ""] = value.split(".");
  const padded = fracPart.padEnd(scale, "0").slice(0, scale);
  return BigInt(intPart + padded);
}

const MAX_CAPITAL_CENTS = BigInt("100000000000"); // 1000000000.00
const MAX_FEE_SCALED = BigInt("1000000"); // 0.01 * 10^8

export function validateBacktestRequest(input: Partial<BacktestRequest>): {
  valid: boolean;
  request?: BacktestRequest;
  issues: ContractIssue[];
} {
  const symbol = input.symbol ?? "SYNTH";
  const interval = input.interval ?? "1d";
  const starting_capital =
    typeof input.starting_capital === "string" ? input.starting_capital : "";
  const position_size =
    typeof input.position_size === "string" ? input.position_size : "";
  const fee_rate = typeof input.fee_rate === "string" ? input.fee_rate : "";

  const issues: ContractIssue[] = [];

  if (symbol !== "SYNTH") {
    issues.push({
      code: "E102_BAD_PARAMETER",
      row: 0,
      column: "symbol",
      message: "Only bundled synthetic symbol SYNTH is supported in this slice.",
    });
  }

  if (!VALID_INTERVALS.has(interval)) {
    issues.push({
      code: "E102_BAD_PARAMETER",
      row: 0,
      column: "interval",
      message: "Interval must be 1d or 15m.",
    });
  }

  if (!CAPITAL_RE.test(starting_capital)) {
    issues.push({
      code: "E102_BAD_PARAMETER",
      row: 0,
      column: "starting_capital",
      message: "Must be > 0 and <= 1000000000.00 with at most 2 decimal places.",
    });
  } else {
    const cents = parseScaledDecimal(starting_capital, 2);
    if (cents <= 0n || cents > MAX_CAPITAL_CENTS) {
      issues.push({
        code: "E102_BAD_PARAMETER",
        row: 0,
        column: "starting_capital",
        message: "Must be > 0 and <= 1000000000.00.",
      });
    }
  }

  if (!SIZE_RE.test(position_size)) {
    issues.push({
      code: "E102_BAD_PARAMETER",
      row: 0,
      column: "position_size",
      message: "Must be an integer from 1 through 1000000 with no leading zero.",
    });
  } else {
    const sizeNum = Number(position_size);
    if (sizeNum < 1 || sizeNum > 1000000) {
      issues.push({
        code: "E102_BAD_PARAMETER",
        row: 0,
        column: "position_size",
        message: "Must be an integer from 1 through 1000000.",
      });
    }
  }

  if (!FEE_RE.test(fee_rate)) {
    issues.push({
      code: "E102_BAD_PARAMETER",
      row: 0,
      column: "fee_rate",
      message: "Must be between 0 and 0.01 inclusive with at most 8 decimal places.",
    });
  } else {
    const feeScaled = parseScaledDecimal(fee_rate, 8);
    if (feeScaled < 0n || feeScaled > MAX_FEE_SCALED) {
      issues.push({
        code: "E102_BAD_PARAMETER",
        row: 0,
        column: "fee_rate",
        message: "Must be between 0 and 0.01 inclusive.",
      });
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    request: {
      symbol: "SYNTH",
      interval: interval as Interval,
      starting_capital,
      position_size,
      fee_rate,
    },
    issues: [],
  };
}

const FRACTION_RE = /^[0-9]+(\.[0-9]+)?$/;

/**
 * Formats a contract drawdown fraction decimal string (e.g. "0.004955") as a
 * display percentage rounded half-up to 2 decimal places (e.g. "0.50%").
 * Uses exact BigInt decimal arithmetic at the display boundary.
 */
export function formatDrawdownPercent(fraction: string | null | undefined): string {
  if (typeof fraction !== "string") return "—";
  const trimmed = fraction.trim();
  if (!FRACTION_RE.test(trimmed)) return "—";

  const [intPart, fracPart = ""] = trimmed.split(".");
  // Multiply by 100 (shift decimal point right by 2) and keep 2 display decimals
  // plus 1 extra digit for half-up rounding => 4 fractional digits from original.
  const padded = fracPart.padEnd(5, "0");
  const shiftedDigits = intPart + padded.slice(0, 4);
  const roundDigit = Number(padded[4]);
  let scaled = BigInt(shiftedDigits);
  if (roundDigit >= 5) {
    scaled += 1n;
  }

  const whole = scaled / 100n;
  const hundredths = (scaled % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${hundredths}%`;
}
