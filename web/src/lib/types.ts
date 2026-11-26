export type Interval = "1d" | "15m";
export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface BacktestRequest {
  symbol: "SYNTH";
  interval: Interval;
  starting_capital: string;
  position_size: string;
  fee_rate: string;
}

export interface BacktestSummary {
  bars: number;
  contract_id: string;
  disclaimer: string;
  fills: number;
  final_equity: string;
  final_position_units: string;
  gross_pnl: string;
  input_file: string;
  input_sha256: string;
  max_drawdown: string;
  max_drawdown_peak_time: number | null;
  max_drawdown_trough_time: number | null;
  net_pnl: string;
  total_fees: string;
}

export interface SimulatedFill {
  id: number;
  signal_time: number;
  fill_time: number;
  side: "BUY" | "SELL";
  units: string;
  price: string;
  notional: string;
  fee: string;
  cash_after: string;
}

export interface EquityPoint {
  time: number;
  cash: string;
  position_units: string;
  close: string;
  equity: string;
  peak: string;
  drawdown: string;
}

export interface BacktestResult {
  summary: BacktestSummary;
  equity_curve: EquityPoint[];
  fills: SimulatedFill[];
}

export interface BacktestRun {
  id: string;
  status: RunStatus;
  created_at: string;
  request: BacktestRequest;
}

export interface BacktestDetail extends BacktestRun {
  result: BacktestResult | null;
  error: string | null;
}

export interface Candle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface CandleList {
  symbol: string;
  interval: Interval;
  candles: Candle[];
}

export interface ContractIssue {
  code: string;
  row: number;
  column: string;
  message: string;
}

export interface AuthUser {
  username: string;
  role: "admin";
}
