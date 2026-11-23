CONTRACT_ID = "ohlc-signal/v2"
DISCLAIMER = (
    "Simulated backtest on synthetic or local data. "
    "Not trading or investment advice. No orders were placed."
)

DEFAULT_STARTING_CAPITAL = "10000.00"
DEFAULT_POSITION_SIZE = "50"
DEFAULT_FEE_RATE = "0.001"
MAX_PRICE_INTEGER_DIGITS = 12

COLUMNS = ("timestamp", "symbol", "open", "high", "low", "close", "volume", "signal")
FILL_COLUMNS = (
    "fill_id", "signal_timestamp", "fill_timestamp", "side", "units",
    "price", "notional", "fee", "cash_after",
)
EQUITY_COLUMNS = ("timestamp", "cash", "position_units", "close", "equity", "peak", "drawdown")
