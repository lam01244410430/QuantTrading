import argparse
import hashlib
import json
from pathlib import Path

from .constants import (
    DEFAULT_FEE_RATE, DEFAULT_POSITION_SIZE, DEFAULT_STARTING_CAPITAL,
    EQUITY_COLUMNS, FILL_COLUMNS,
)
from .engine import simulate
from .report import render_report
from .validation import Rejected, parameters, read_input, validate


def _write(path, content):
    path.write_bytes(content.encode("utf-8"))


def _csv(header, rows):
    return "\n".join([",".join(header), *(",".join(row) for row in rows)]) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run a local ohlc-signal/v2 backtest.",
                                     allow_abbrev=False)
    parser.add_argument("input", help="local OHLC+signal CSV path")
    parser.add_argument("--out", required=True, type=Path, help="output directory")
    parser.add_argument("--starting-capital", default=DEFAULT_STARTING_CAPITAL)
    parser.add_argument("--position-size", default=DEFAULT_POSITION_SIZE)
    parser.add_argument("--fee-rate", default=DEFAULT_FEE_RATE)
    parser.add_argument("--html", action="store_true", help="also write a standalone report.html")
    args = parser.parse_args(argv)

    try:
        params = parameters(args.starting_capital, args.position_size, args.fee_rate)
        raw = read_input(args.input)
        bars = validate(raw)
        fills, equity, summary = simulate(
            bars, params, Path(args.input).name, hashlib.sha256(raw).hexdigest()
        )
    except Rejected as exc:
        args.out.mkdir(parents=True, exist_ok=True)
        _write(args.out / "errors.csv", _csv(
            ("code", "row", "column"),
            ((issue.code, str(issue.row), issue.column) for issue in exc.issues),
        ))
        return exc.exit_code

    args.out.mkdir(parents=True, exist_ok=True)
    _write(args.out / "fills.csv", _csv(FILL_COLUMNS, fills))
    _write(args.out / "equity.csv", _csv(EQUITY_COLUMNS, equity))
    _write(args.out / "summary.json", json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=True) + "\n")
    if args.html:
        _write(args.out / "report.html", render_report(summary, fills, equity))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
