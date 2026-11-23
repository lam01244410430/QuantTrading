# QuantTrading

QuantTrading is an offline Python backtester for local OHLC and target-position
signals (`ohlc-signal/v2`, amendment 2.1.1). It requires Python 3.10 or newer and
has no runtime dependencies beyond the standard library.

**Simulated backtest on synthetic or local data. Not trading or investment
advice. No orders were placed.** The backtester uses no network data,
credentials, brokers, exchanges, real orders, or schedules.

## Install and run the demo

From the repository root on macOS or Linux, create and activate a virtual
environment, then install the package:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install .
```

Installation may need access to a package index for the build dependency.
If you are already offline, you can skip the package install when running
from this checkout; the backtester uses only the Python standard library.

```sh
make demo
```

If Make is unavailable, run the same demo directly from the repository root
with Python 3.10+ (on Windows, use your Python launcher in place of `python` if
needed):

```sh
python -m quanttrading.backtest fixtures/fixture_v1_basic.csv --out out --html
```

Open `out/report.html` in your browser (for example, double-click it in your
file manager). It is a standalone file: no server or internet connection is
needed. The demo uses synthetic `SYNTH` data, not actual market history. It
shows two simulated fills, total fees of 10.23, and final equity of 10199.77.

## Run on your own CSV

See the [usage guide](docs/usage.md) for a copyable local CSV example, the
required columns, CLI parameters and bounds, generated files, and error codes.

## Tests

In the activated virtual environment, install the hash-pinned test
requirements, then run the tests:

```sh
python -m pip install -r requirements-dev.txt
python -m pytest
```
