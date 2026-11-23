# QuantTrading

QuantTrading is an offline Python backtester for local OHLC and target-position
signals (`ohlc-signal/v2`, amendment 2.1.1). It requires Python 3.10 or newer and
has no runtime dependencies beyond the standard library.

## Try the demo

From the repository folder, run:

| Platform | Command |
| --- | --- |
| Windows (PowerShell) | `py -3 -m quanttrading.backtest fixtures/fixture_v1_basic.csv --out out --html` |
| macOS / Linux | `python3 -m quanttrading.backtest fixtures/fixture_v1_basic.csv --out out --html` (or `make demo`) |

Double-click `out/report.html` to open the equity chart, summary, and simulated
fills in your browser. No server or internet access is needed. The demo uses
the contract's synthetic `SYNTH` data, not actual market history. It produces
two fills, total fees of 10.23, and final equity of 10199.77.

## Run on your own local data

```sh
python3 -m quanttrading.backtest path/to/local.csv --out my-run --starting-capital 10000.00 --position-size 50 --fee-rate 0.001 --html
```

On Windows, use `py -3` in place of `python3`. The three parameter values
shown are the defaults. Omit `--html` if you only want the contract files.
Each completed run replaces this tool's previous outputs in the chosen
directory and leaves unrelated files alone.
Both input and output must be local paths. URIs and UNC network paths
starting with `\\` or `//` are rejected as E103. For a non-local output
path, the CLI writes no files and prints the `code,row,column` header and
`E103_INPUT_NOT_LOCAL,0,out` row to stderr.

Start your UTF-8 CSV (no BOM) with this exact header and include at least two
bars for one symbol, with unique, increasing UTC bar-open timestamps:

```csv
timestamp,symbol,open,high,low,close,volume,signal
```

Fields are not quoted or trimmed. Prices must be positive, with at most 12
integer digits and up to 8 fractional digits. Volume is a nonnegative integer.
Signal `1` targets a long position and `0` targets flat; each change executes
at the next bar's open with the configured fee. The last signal never executes,
and any position still open is valued at the last close.

Success writes `fills.csv`, `equity.csv`, and `summary.json` (exit 0), plus the
optional HTML report. Failure writes only `errors.csv` for that invocation:
exit 2 for CSV validation, 3 for invalid parameters or paths, and 4 if a buy
cannot be funded. The summary records the contract version, parameters, and
the SHA-256 of the original input bytes. It records the input basename only:
filename bytes are decoded as UTF-8 regardless of locale, with invalid bytes
shown as `\xNN` escapes.
The summary shows starting capital to two decimal places and the fee rate
exactly as supplied.

**Simulated backtest on synthetic or local data. Not trading or investment
advice. No orders were placed.** The backtester uses no network data,
credentials, brokers, exchanges, real orders, or schedules.

## Tests

In a Python virtual environment, install the hash-pinned test requirements
with `python -m pip install -r requirements-dev.txt`, then run
`python -m pytest`. The backtester itself needs no installation to run
from the repository folder.