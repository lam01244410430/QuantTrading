import argparse
import hashlib
import json
import os
from pathlib import Path
from shutil import copy2
import stat
import sys
from tempfile import TemporaryDirectory

from .constants import (
    DEFAULT_FEE_RATE, DEFAULT_POSITION_SIZE, DEFAULT_STARTING_CAPITAL,
    EQUITY_COLUMNS, FILL_COLUMNS,
)
from .engine import simulate
from .report import render_report
from .validation import Rejected, is_local_input, is_unc, parameters, read_input, validate

OUTPUT_NAMES = ("fills.csv", "equity.csv", "summary.json", "errors.csv", "report.html")
PARAMETER_DEFAULTS = {
    "--starting-capital": DEFAULT_STARTING_CAPITAL,
    "--position-size": DEFAULT_POSITION_SIZE,
    "--fee-rate": DEFAULT_FEE_RATE,
}


def _parameter_args(argv):
    arguments = iter(argv)
    for argument in arguments:
        if argument == "--":
            yield argument
            yield from arguments
            break
        if argument in PARAMETER_DEFAULTS:
            value = next(arguments, None)
            if value is not None:
                argument = f"{argument}={value}"
        yield argument


def _write_outputs(out, outputs):
    out.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".quanttrading-", dir=out) as staging:
        stage = Path(staging)
        backups = {}
        for name, content in outputs.items():
            (stage / name).write_bytes(content.encode("utf-8"))
        for name in OUTPUT_NAMES:
            destination = out / name
            try:
                mode = destination.lstat().st_mode
            except FileNotFoundError:
                continue
            if not (stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
                raise OSError(f"Output path is not a regular file: {destination}")
            backups[name] = stage / (name + ".previous")
            copy2(destination, backups[name], follow_symlinks=False)

        changed = []
        try:
            for name in outputs:
                os.replace(stage / name, out / name)
                changed.append(name)
            for name in backups:
                if name not in outputs:
                    (out / name).unlink()
                    changed.append(name)
        except OSError:
            for name in reversed(changed):
                if name in backups:
                    os.replace(backups[name], out / name)
                else:
                    (out / name).unlink()
            raise


def _csv(header, rows):
    return "\n".join([",".join(header), *(",".join(row) for row in rows)]) + "\n"


def _input_alias(input_path, out):
    if not is_local_input(input_path):
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
    parser.add_argument("--out", required=True, help="output directory")
    for flag, default in PARAMETER_DEFAULTS.items():
        parser.add_argument(flag, default=default)
    parser.add_argument("--html", action="store_true", help="also write a standalone report.html")
    args = parser.parse_args(_parameter_args(sys.argv[1:] if argv is None else argv))

    if is_unc(args.out):
        print("Output directory must be local; UNC paths are not supported.", file=sys.stderr)
        return 3
    out = Path(args.out)

    try:
        alias = _input_alias(args.input, out)
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
        basename = os.fsencode(Path(args.input).name).decode("utf-8", errors="backslashreplace")
        fills, equity, summary = simulate(
            bars, params, basename, hashlib.sha256(raw).hexdigest()
        )
    except Rejected as exc:
        status = exc.exit_code
        outputs = {"errors.csv": _csv(
            ("code", "row", "column"),
            ((issue.code, str(issue.row), issue.column) for issue in exc.issues),
        )}
    else:
        status = 0
        outputs = {
            "fills.csv": _csv(FILL_COLUMNS, fills),
            "equity.csv": _csv(EQUITY_COLUMNS, equity),
            "summary.json": json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=True) + "\n",
        }
        if args.html:
            outputs["report.html"] = render_report(summary, fills, equity)

    try:
        _write_outputs(out, outputs)
    except OSError as exc:
        print(f"Cannot write backtest output: {exc}", file=sys.stderr)
        return 3
    return status


if __name__ == "__main__":
    raise SystemExit(main())
