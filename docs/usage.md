# Offline backtester usage

This guide covers `ohlc-signal/v2`, amendment 2.1.1. See the
[README](../README.md#install-and-run-the-demo) for installation and the demo.
The CLI reads one synthetic or user-provided local CSV and writes to a local
directory. It does not download data, connect to a broker or exchange, use
credentials, place orders, or run on a schedule.

## Run a local CSV

After running the demo, save these three lines as `out/local.csv` in the
repository. This example uses synthetic prices. The same command works with
your own CSV: replace `out/local.csv` with its path and quote paths with spaces.

```csv
timestamp,symbol,open,high,low,close,volume,signal
2026-01-05T00:00:00Z,SYNTH_LOCAL,10.00,11.00,9.00,10.00,100,1
2026-01-06T00:00:00Z,SYNTH_LOCAL,11.00,12.00,10.00,12.00,200,0
```

From the repository root, with the virtual environment active:

```sh
python -m quanttrading.backtest out/local.csv --out out/local-run --starting-capital 10000.00 --position-size 50 --fee-rate 0.001 --html
```

Open `out/local-run/report.html` in your browser. This example produces one
simulated BUY of 50 units at 11.00 on the second bar, a fee of 0.55, and
closing equity of 10049.45. The second bar's flat signal has no later bar on
which to execute.

## Input columns and format

Use the exact case-sensitive header shown above, in that order, with no extra
columns. Provide at least two rows for one symbol and one bar interval.
The CLI does not check the interval. Calendar gaps are allowed; the next row
is the next bar for execution.

Use UTF-8 without a BOM, LF or CRLF line endings (either or both), and no
blank lines. The final line terminator is optional; a second terminator
creates a blank row. Fields are split on commas without quoting or trimming.
Empty or whitespace-only fields and the case-insensitive tokens `nan`,
`null`, `na`, `none`, and `n/a` count as missing.

| Column(s) | Accepted values |
| --- | --- |
| `timestamp` | A real UTC bar-open time in `YYYY-MM-DDTHH:MM:SSZ` format, with no fractional seconds or offsets. Timestamps must be unique and strictly increasing. |
| `symbol` | 1–16 characters from `A-Z`, `0-9`, `.`, `_`, or `-`; identical on every row. |
| `open`, `high`, `low`, `close` | Positive decimals with 1–12 integer digits and an optional decimal point followed by 1–8 digits. `low` must be at most `high`; both `open` and `close` must be within that inclusive range. |
| `volume` | A nonnegative integer (one or more digits). |
| `signal` | Exactly `0` (target flat) or `1` (target long). |

Numeric fields use ASCII digits, no leading plus sign, exponents, separators,
or surrounding whitespace.

## CLI arguments and bounds

The input path is a required positional argument and must point to a readable
regular file. `--out` is required and names the output directory, which is
created if absent. Both paths must be local. The CLI rejects URI forms such
as `https://`, `s3://`, and `file://` and paths beginning with two backslashes
or a mixed slash/backslash pair. It also rejects `//` on Windows, but allows
that prefix for local paths on POSIX.

| Flag | Default | Accepted values |
| --- | --- | --- |
| `--starting-capital` | `10000.00` | Greater than 0 and at most 1000000000.00 in account currency. One or more digits, optionally followed by a decimal point and 1–2 digits. |
| `--position-size` | `50` | Integer from 1 through 1000000 units, with no leading zero. |
| `--fee-rate` | `0.001` | From 0 through 0.01 inclusive, as a fraction of notional per fill (`0.001` = 0.1%). One or more digits, optionally followed by a decimal point and 1–8 digits. |
| `--html` | Off | Add a standalone HTML report; this flag takes no value. |

Parameters follow the same ASCII digit and whitespace rules as CSV numbers.
The simulation starts flat. A signal decided at a bar's close is applied at
the next bar's open only if the target differs from the current position.
There is no leverage, shorting, slippage, or partial filling. Notional is
fill price times units; the fee is rounded half up to cents. A buy must
cover notional plus fee from available cash. The last signal never executes,
and any still-open position is valued at the final close, not force-closed.

## Outputs

On success (exit 0), look in the directory given to `--out`:

| File | Contents |
| --- | --- |
| `fills.csv` | One row per simulated fill (header only if none): `fill_id,signal_timestamp,fill_timestamp,side,units,price,notional,fee,cash_after`. |
| `equity.csv` | One row per bar, after any fill at its open: `timestamp,cash,position_units,close,equity,peak,drawdown`. Equity marks the position at that bar's close; the initial peak is starting capital. |
| `summary.json` | Run counts, symbol, final equity and position, gross and net P&L, fees, maximum drawdown and its timestamps, parameters, contract ID, disclaimer, input basename, and SHA-256 of the raw input bytes. JSON values are strings (the parameters are grouped in an object). |
| `report.html` | With `--html` only: standalone equity chart, summary, and simulated fills. Open it directly in a browser; no server is needed. |

CSV and JSON outputs are UTF-8, with LF line endings and a final terminator.
Reported money uses two decimal places and drawdown uses six (drawdown is a
fraction, not a percentage). Output prices retain their input spelling. The
summary retains the supplied fee rate, prints starting capital to two
decimal places, and records only the input basename. Invalid UTF-8 filename
bytes are represented with `\xNN` escapes.

Each completed run replaces this tool's prior outputs in the chosen directory
and removes stale ones (for example, a prior HTML report if `--html` is
omitted). Unrelated files are left alone. Use distinct output directories to
keep multiple runs.

## Exit statuses and errors

For a rejected run, look for `errors.csv` in the output directory rather than
partial results. Its header is `code,row,column`. Row 0 is the header or a
file/run-level issue; the first data row is 1. An empty column indicates a
row- or file-level error without a specific field.

If `--out` is non-local, nothing is written: stderr receives the same CSV
header and `E103_INPUT_NOT_LOCAL,0,out`, preceded by any parameter error
rows. A non-local input alone reports E103 with an empty column. An output
filesystem error or a conflict where a managed output aliases the input can
also exit 3 with a diagnostic on stderr rather than a new `errors.csv`. If
restoring prior outputs fails after a write error, stderr gives the location
of retained backups.

| Exit | Meaning |
| --- | --- |
| `0` | Success. |
| `2` | Invalid CSV (E001–E017); also used for CLI usage errors such as missing required arguments, which print to stderr instead of writing `errors.csv`. |
| `3` | Invalid parameters or path, unreadable input, or inability to publish outputs. |
| `4` | Insufficient cash for a simulated buy (E101). |

| Code | Meaning |
| --- | --- |
| `E001_FILE_EMPTY` | Empty file or empty first line. |
| `E002_HEADER_MISMATCH` | Header does not match the required names and order exactly. |
| `E003_TOO_FEW_ROWS` | Fewer than two lines after the header, counting even invalid lines. |
| `E004_FIELD_COUNT` | A row does not have eight fields; this includes blank lines. |
| `E005_MISSING_VALUE` | A field is empty, whitespace-only, or a missing-value token. |
| `E006_BAD_TIMESTAMP` | Invalid timestamp format or date/time. |
| `E007_DUPLICATE_TIMESTAMP` | Timestamp equals any earlier valid timestamp. |
| `E008_OUT_OF_ORDER` | Nonduplicate timestamp precedes the nearest earlier valid timestamp. |
| `E009_SYMBOL_INVALID` | Symbol does not match the required format. |
| `E010_SYMBOL_MISMATCH` | Valid symbol differs from the first valid symbol. |
| `E011_BAD_NUMBER` | Price or volume does not match the numeric format. |
| `E012_NON_POSITIVE_PRICE` | A numeric price is zero or negative. |
| `E013_HIGH_LT_LOW` | High is below low. |
| `E014_OPEN_CLOSE_OUT_OF_RANGE` | Open or close is outside the inclusive low–high range, reported per offending field. |
| `E015_NEGATIVE_VOLUME` | Volume has a minus sign followed by digits. |
| `E016_BAD_SIGNAL` | Signal is not exactly `0` or `1`. |
| `E017_BAD_ENCODING` | The file begins with a UTF-8 BOM or contains invalid UTF-8. |
| `E101_INSUFFICIENT_CASH` | Buy notional plus fee exceeds cash. The row is the attempted fill bar, not the signal bar. |
| `E102_BAD_PARAMETER` | A parameter fails its format or bound. The column is the parameter name (`starting_capital`, `position_size`, or `fee_rate`). |
| `E103_INPUT_NOT_LOCAL` | The input path or output directory is a URI or a rejected network-path form. |
| `E104_INPUT_UNREADABLE` | The input is missing, unreadable, or not a regular file. |

Parameters are checked before opening the input. File-level CSV checks stop
at the first failure (encoding, empty file, then header); after that,
row-level errors are collected and sorted by row, then column in header order
(empty column first), then code. Rows with the wrong number of fields skip
other checks; invalid fields are not used in dependent checks. A duplicate
timestamp is not also out of order. Price-range checks require all four
prices to be valid, and high below low suppresses open/close range checks for
that row.
