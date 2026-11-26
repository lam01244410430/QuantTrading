from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select

from quanttrading.constants import COLUMNS
from quanttrading.validation import validate

from .database import candles

EXCHANGE = "synthetic"
MARKET = "fixture"
FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "fixture_v1_basic.csv"


def fixture_rows():
    raw = FIXTURE.read_bytes()
    bars = validate(raw)
    source = raw.decode().splitlines()[1:]
    start = datetime.fromisoformat(bars[0].timestamp)
    for idx, (bar, line) in enumerate(zip(bars, source, strict=True)):
        _, _, open_, high, low, close, volume, _ = line.split(",")
        for timeframe, open_ts in (
            ("1d", datetime.fromisoformat(bar.timestamp)),
            ("15m", start + timedelta(minutes=15 * idx)),
        ):
            yield {
                "exchange": EXCHANGE, "market": MARKET, "symbol": bar.symbol,
                "timeframe": timeframe, "open_ts": open_ts, "is_closed": True,
                "open": Decimal(open_), "high": Decimal(high), "low": Decimal(low),
                "close": Decimal(close), "volume": Decimal(volume), "signal": bar.signal,
            }


def closed_series(symbol, interval):
    return select(candles).where(
        candles.c.exchange == EXCHANGE,
        candles.c.market == MARKET,
        candles.c.symbol == symbol,
        candles.c.timeframe == interval,
        candles.c.is_closed.is_(True),
    )


def decimal_text(value: Decimal) -> str:
    return format(value, "f")


def source_bytes(rows) -> bytes:
    lines = [",".join(COLUMNS)]
    for row in rows:
        timestamp = row.open_ts.strftime("%Y-%m-%dT%H:%M:%SZ")
        values = (row.open, row.high, row.low, row.close, row.volume)
        lines.append(",".join((timestamp, row.symbol, *map(decimal_text, values), str(row.signal))))
    return ("\n".join(lines) + "\n").encode()
