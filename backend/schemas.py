from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from quanttrading.validation import Rejected, parameters

Interval = Literal["15m", "1d"]
Price = Annotated[str, Field(pattern=r"^[0-9]+(?:\.[0-9]+)?$")]
SignedDecimal = Annotated[str, Field(pattern=r"^-?[0-9]+(?:\.[0-9]+)?$")]
RunStatus = Literal["queued", "running", "succeeded", "failed"]
ChartTime = Annotated[int, Field(description="UTC Unix seconds")]


class Admin(BaseModel):
    username: str
    role: Literal["admin"] = "admin"


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: Annotated[str, Field(min_length=1, max_length=128)]
    password: Annotated[SecretStr, Field(min_length=1, max_length=1024)]


class LoginResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    user: Admin


class Candle(BaseModel):
    time: ChartTime
    open: Price
    high: Price
    low: Price
    close: Price
    volume: Price


class CandleList(BaseModel):
    symbol: str
    interval: Interval
    candles: list[Candle]


class BacktestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: Literal["SYNTH"] = "SYNTH"
    interval: Interval = "1d"
    starting_capital: Annotated[str, Field(pattern=r"^[0-9]{1,10}(?:\.[0-9]{1,2})?$")] = "10000.00"
    position_size: Annotated[str, Field(pattern=r"^[1-9][0-9]{0,6}$")] = "50"
    fee_rate: Annotated[str, Field(pattern=r"^[0-9]{1,2}(?:\.[0-9]{1,8})?$")] = "0.001"

    @model_validator(mode="after")
    def validate_parameters(self) -> "BacktestRequest":
        try:
            parameters(self.starting_capital, self.position_size, self.fee_rate)
        except Rejected as exc:
            fields = ", ".join(issue.column for issue in exc.issues)
            raise ValueError(f"Out-of-range backtest parameters: {fields}") from exc
        return self


class BacktestRun(BaseModel):
    id: UUID
    status: RunStatus
    created_at: datetime
    request: BacktestRequest


class BacktestList(BaseModel):
    runs: list[BacktestRun]


class BacktestSummary(BaseModel):
    contract_id: str
    disclaimer: str
    bars: int
    fills: int
    final_equity: Price
    final_position_units: Price
    gross_pnl: SignedDecimal
    net_pnl: SignedDecimal
    total_fees: Price
    max_drawdown: Price
    max_drawdown_peak_time: ChartTime | None
    max_drawdown_trough_time: ChartTime | None
    input_file: str
    input_sha256: str


class EquityPoint(BaseModel):
    time: ChartTime
    cash: Price
    position_units: Price
    close: Price
    equity: Price
    peak: Price
    drawdown: Price


class SimulatedFill(BaseModel):
    id: int
    signal_time: ChartTime
    fill_time: ChartTime
    side: Literal["BUY", "SELL"]
    units: Price
    price: Price
    notional: Price
    fee: Price
    cash_after: Price


class BacktestResult(BaseModel):
    summary: BacktestSummary
    equity_curve: list[EquityPoint]
    fills: list[SimulatedFill]


class BacktestDetail(BacktestRun):
    result: BacktestResult | None
    error: str | None
