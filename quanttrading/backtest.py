import argparse
import hashlib
import json
import os
from pathlib import Path
from shutil import rmtree
import stat
import sys
from tempfile import mkdtemp

from .constants import (
    DEFAULT_FEE_RATE, DEFAULT_POSITION_SIZE, DEFAULT_STARTING_CAPITAL,
    EQUITY_COLUMNS, FILL_COLUMNS,
)
from .engine import simulate
from .report import render_report
from .validation import Issue, Rejected, is_local_path, parameters, read_input, validate

OUTPUT_NAMES = ("fills.csv", "equity.csv", "summary.json", "errors.csv", "report.html")
ERROR_COLUMNS = ("code", "row", "column")
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
    stage = Path(mkdtemp(prefix=".quanttrading-", dir=out))
    retain_backups = False
    try:
        existing = []
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
            existing.append(name)

        stale = [name for name in existing if name not in outputs]
        changed = {}
        retain_backups = True
        try:
            for name in (*outputs, *stale):
                destination = out / name
                if name in existing:
                    backup = stage / (name + ".previous")
                    changed[name] = backup
                    os.replace(destination, backup)
                if name in outputs:
                    changed.setdefault(name, None)
                    os.replace(stage / name, destination)
        except BaseException as publish_error:
            rollback_errors = []
            for name, backup in reversed(changed.items()):
                try:
                    if backup is None:
                        (out / name).unlink(missing_ok=True)
                        continue
                    try:
                        backup.lstat()
                    except FileNotFoundError:
                        continue
                    os.replace(backup, out / name)
                except BaseException as rollback_error:
                    rollback_errors.append((name, rollback_error))
            if rollback_errors:
                details = "; ".join(f"{name}: {error}" for name, error in rollback_errors)
                message = f"rollback failed ({details}); recovery files kept at {stage}"
                if isinstance(publish_error, OSError):
                    interrupt = next((error for _, error in rollback_errors
                                      if not isinstance(error, OSError)), None)
                    if interrupt is None:
                        raise OSError(f"{publish_error}; {message}") from publish_error
                    print(message, file=sys.stderr)
                    raise interrupt from publish_error
                print(message, file=sys.stderr)
            else:
                retain_backups = False
            raise
        else:
            retain_backups = False
    finally:
        if not retain_backups:
            rmtree(stage)


def _csv(header, rows):
    return "\n".join([",".join(header), *(",".join(row) for row in rows)]) + "\n"


def _errors_csv(issues):
    return _csv(ERROR_COLUMNS, ((issue.code, str(issue.row), issue.column) for issue in issues))


def _input_alias(input_path, out):
    if not is_local_path(input_path):
        return None
    source = Path(input_path)
    try:
        source_stat = source.stat()
    except OSError:
        return None
    try:
        resolved = os.path.normcase(os.path.realpath(source))
    except OSError:
        resolved = None
    for name in OUTPUT_NAMES:
        destination = out / name
        if resolved is not None and os.path.normcase(os.path.realpath(destination)) == resolved:
            return name
        try:
            if os.path.samestat(source_stat, destination.stat()):
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

    out_is_local = is_local_path(args.out)
    status, issues = 0, ()
    try:
        params = parameters(args.starting_capital, args.position_size, args.fee_rate)
        if out_is_local:
            raw = read_input(args.input)
            bars = validate(raw)
            basename = os.fsencode(Path(args.input).name).decode("utf-8", errors="backslashreplace")
            fills, equity, summary = simulate(
                bars, params, basename, hashlib.sha256(raw).hexdigest()
            )
    except Rejected as exc:
        status, issues = exc.exit_code, exc.issues

    if not out_is_local:
        issues = (*issues, Issue("E103_INPUT_NOT_LOCAL", column="out"))
        sys.stderr.buffer.write(_errors_csv(issues).encode("utf-8"))
        return 3

    if status:
        outputs = {"errors.csv": _errors_csv(issues)}
    else:
        outputs = {
            "fills.csv": _csv(FILL_COLUMNS, fills),
            "equity.csv": _csv(EQUITY_COLUMNS, equity),
            "summary.json": json.dumps(summary, indent=2, sort_keys=True, ensure_ascii=True) + "\n",
        }
        if args.html:
            outputs["report.html"] = render_report(summary, fills, equity)

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
        _write_outputs(out, outputs)
    except OSError as exc:
        print(f"Cannot write backtest output: {exc}", file=sys.stderr)
        return 3
    return status


if __name__ == "__main__":
    raise SystemExit(main())
