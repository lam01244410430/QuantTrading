import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from .constants import (
    DEFAULT_FEE_RATE, DEFAULT_POSITION_SIZE, DEFAULT_STARTING_CAPITAL,
    EQUITY_COLUMNS, FILL_COLUMNS,
)
from .engine import simulate
from .report import render_report
from .validation import URI, Rejected, parameters, read_input, validate

OUTPUT_NAMES = ("fills.csv", "equity.csv", "summary.json", "errors.csv", "report.html")


def _write(path, content):
    path.write_bytes(content.encode("utf-8"))


def _csv(header, rows):
    return "\n".join([",".join(header), *(",".join(row) for row in rows)]) + "\n"


def _input_alias(input_path, out):
    if URI.match(input_path):
        return None
    source = Path(input_path)
    resolved = os.path.normcase(os.path.realpath(source))
    for name in OUTPUT_NAMES:
        destination = out / name
        if os.path.normcase(os.path.realpath(destination)) == resolved:
            return name
        try:
            if source.samefile(destination):
                return name
        except (FileNotFoundError, NotADirectoryError):
            continue
    return None


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
        alias = _input_alias(args.input, args.out)
    except OSError as exc:
        print(f"Cannot check output paths: {exc}", file=sys.stderr)
        return 3
    if alias:
        print(f"Output {alias} aliases the input file; no output was written.", file=sys.stderr)
        return 3

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
