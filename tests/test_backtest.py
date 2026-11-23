import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from quanttrading.backtest import main

ROOT = Path(__file__).resolve().parents[1]
BASIC = ROOT / "fixtures" / "fixture_v1_basic.csv"
EXPECTED = Path(__file__).with_name("expected")
INPUT_SHA = "f6f56221ed9fa14c99763f64e4956b5baef28d1482c2d7448d5a7222dff6923a"
OUTPUT_SHA = {
    "fills.csv": "10b1636f9443ce94dd5f54871aafbb59eeafe6b29759d209b478dbb9f8e8908c",
    "equity.csv": "05a03a3417a929b14b5c997a16fca76f6884c6492d8ccfa8e91bee0b16e32a13",
    "summary.json": "bdddaea2827fcfaff4d6833a526173bdaabf2780b1712c91645ba2109214c5da",
}
RAW = BASIC.read_bytes()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def edit(*changes, raw=RAW):
    lines = raw.split(b"\n")
    for row, column, value in changes:
        fields = lines[row].split(b",")
        fields[column] = value.encode("utf-8")
        lines[row] = b",".join(fields)
    return b"\n".join(lines)


def swap_rows(first, second):
    rows = RAW.split(b"\n")
    rows[first], rows[second] = rows[second], rows[first]
    return b"\n".join(rows)


def run(tmp_path, raw=RAW, flags=(), filename=BASIC.name):
    tmp_path.mkdir(parents=True, exist_ok=True)
    source = tmp_path / filename
    source.write_bytes(raw)
    out = tmp_path / "out"
    status = main([str(source), "--out", str(out), *flags])
    return status, out


def assert_errors(out, *errors):
    assert {path.name for path in out.iterdir()} == {"errors.csv"}
    expected = "code,row,column\n" + "\n".join(errors) + "\n"
    assert (out / "errors.csv").read_bytes() == expected.encode("utf-8")


def test_positive_bytes_and_hashes(tmp_path):
    assert sha(RAW) == INPUT_SHA
    status, out = run(tmp_path)
    assert status == 0
    assert {path.name for path in out.iterdir()} == OUTPUT_SHA.keys()
    for name, checksum in OUTPUT_SHA.items():
        actual = (out / name).read_bytes()
        assert actual == (EXPECTED / name).read_bytes()
        assert sha(actual) == checksum


@pytest.mark.parametrize(("raw", "error"), [
    pytest.param(edit((3, 0, "2026-01-06T00:00:00Z")), "E007_DUPLICATE_TIMESTAMP,3,timestamp", id="N01"),
    pytest.param(swap_rows(3, 4), "E008_OUT_OF_ORDER,4,timestamp", id="N02"),
    pytest.param(edit((2, 3, "99.00")), "E013_HIGH_LT_LOW,2,high", id="N03"),
    pytest.param(edit((2, 2, "0")), "E012_NON_POSITIVE_PRICE,2,open", id="N04"),
    pytest.param(edit((2, 5, "")), "E005_MISSING_VALUE,2,close", id="N05"),
    pytest.param(RAW.replace(b",1200,1", b",1"), "E004_FIELD_COUNT,2,", id="N06"),
    pytest.param(edit((2, 7, "2")), "E016_BAD_SIGNAL,2,signal", id="N07"),
    pytest.param(edit((2, 2, "100.100000000")), "E011_BAD_NUMBER,2,open", id="B01"),
    pytest.param(edit((2, 2, "1e2")), "E011_BAD_NUMBER,2,open", id="B02"),
    pytest.param(edit((2, 2, "Infinity")), "E011_BAD_NUMBER,2,open", id="B03"),
    pytest.param(edit((2, 2, "NaN")), "E005_MISSING_VALUE,2,open", id="B04"),
    pytest.param(edit((2, 7, "1.0")), "E016_BAD_SIGNAL,2,signal", id="B05"),
    pytest.param(edit((2, 4, "-99.50")), "E012_NON_POSITIVE_PRICE,2,low", id="B06"),
    pytest.param(edit((2, 6, "-1")), "E015_NEGATIVE_VOLUME,2,volume", id="B07"),
    pytest.param(edit((2, 6, "1.5")), "E011_BAD_NUMBER,2,volume", id="B08"),
    pytest.param(edit((2, 2, " 100.10")), "E011_BAD_NUMBER,2,open", id="B09"),
    pytest.param(edit((2, 2, "+100.10")), "E011_BAD_NUMBER,2,open", id="B10"),
    pytest.param(edit((2, 0, "2026-02-30T00:00:00Z")), "E006_BAD_TIMESTAMP,2,timestamp", id="B11"),
    pytest.param(edit((2, 0, "2026-01-06T00:00:00+00:00")), "E006_BAD_TIMESTAMP,2,timestamp", id="B12"),
    pytest.param(edit((2, 1, "SYNTH_B")), "E010_SYMBOL_MISMATCH,2,symbol", id="B13"),
    pytest.param(edit((2, 1, "synth")), "E009_SYMBOL_INVALID,2,symbol", id="B14"),
    pytest.param(b"\xef\xbb\xbf" + RAW, "E017_BAD_ENCODING,0,", id="B15"),
    pytest.param(RAW + b"\n", "E004_FIELD_COUNT,7,", id="B16"),
    pytest.param(edit((0, 7, "signal ")), "E002_HEADER_MISMATCH,0,", id="B19"),
    pytest.param(b"\n".join(RAW.split(b"\n")[:2]) + b"\n", "E003_TOO_FEW_ROWS,0,", id="B20"),
    pytest.param(b"", "E001_FILE_EMPTY,0,", id="B21"),
    pytest.param(edit((2, 2, "103.50")), "E014_OPEN_CLOSE_OUT_OF_RANGE,2,open", id="B22"),
    pytest.param(RAW.replace(b"1200,1\n", b"1200,1\n\n"), "E004_FIELD_COUNT,3,", id="B23"),
    pytest.param(edit((2, 5, "null")), "E005_MISSING_VALUE,2,close", id="B24"),
    pytest.param(b"\n" + RAW, "E001_FILE_EMPTY,0,", id="empty-header"),
    pytest.param(b"not a header\n\xff", "E017_BAD_ENCODING,0,", id="invalid-utf8-precedence"),
    pytest.param(RAW.rstrip(b"\n") + b"\r", "E016_BAD_SIGNAL,6,signal", id="lone-cr"),
    pytest.param(edit((2, 2, "1234567890123.0")), "E011_BAD_NUMBER,2,open", id="price-cap"),
])
def test_invalid_fixtures(tmp_path, raw, error):
    status, out = run(tmp_path, raw)
    assert status == 2
    assert_errors(out, error)


@pytest.mark.parametrize("raw", [
    pytest.param(RAW[:-1], id="B17"),
    pytest.param(RAW.replace(b"\n", b"\r\n"), id="B18"),
    pytest.param(RAW.replace(b"1200,1\n", b"1200,1\r\n"), id="mixed-endings"),
])
def test_boundary_valid_bytes(tmp_path, raw):
    status, out = run(tmp_path, raw)
    assert status == 0
    for name in OUTPUT_SHA:
        expected = (EXPECTED / name).read_bytes()
        if name == "summary.json":
            expected = expected.replace(INPUT_SHA.encode(), sha(raw).encode())
        assert (out / name).read_bytes() == expected


def test_file_and_row_errors_are_accumulated(tmp_path):
    raw = edit((1, 0, "impossible"), (1, 1, " "), (1, 2, "500"), (1, 5, "1"),
               (1, 6, "1e2"), (1, 7, "true"))
    status, out = run(tmp_path, b"\n".join(raw.split(b"\n")[:2]))
    assert status == 2
    assert_errors(out, "E003_TOO_FEW_ROWS,0,", "E006_BAD_TIMESTAMP,1,timestamp",
                  "E005_MISSING_VALUE,1,symbol", "E014_OPEN_CLOSE_OUT_OF_RANGE,1,open",
                  "E014_OPEN_CLOSE_OUT_OF_RANGE,1,close", "E011_BAD_NUMBER,1,volume",
                  "E016_BAD_SIGNAL,1,signal")


def test_timestamp_compares_to_duplicate_but_never_to_invalid_row(tmp_path):
    raw = edit((1, 0, "2026-01-07T00:00:00Z"), (2, 0, "2026-01-08T00:00:00Z"),
               (3, 0, "bad timestamp"), (4, 0, "2026-01-07T00:00:00Z"),
               (5, 0, "2026-01-07T12:00:00Z"))
    status, out = run(tmp_path, raw)
    assert status == 2
    assert_errors(out, "E006_BAD_TIMESTAMP,3,timestamp", "E007_DUPLICATE_TIMESTAMP,4,timestamp")


@pytest.mark.parametrize(("flag", "value", "column"), [
    pytest.param("--fee-rate", "0.02", "fee_rate", id="P01"),
    pytest.param("--position-size", "0", "position_size", id="P02"),
    pytest.param("--starting-capital", "1000000000.01", "starting_capital", id="capital-cap"),
    pytest.param("--starting-capital", "0", "starting_capital", id="zero-capital"),
    pytest.param("--starting-capital", "1.000", "starting_capital", id="capital-precision"),
    pytest.param("--position-size", "1000001", "position_size", id="size-cap"),
    pytest.param("--position-size", "050", "position_size", id="size-leading-zero"),
    pytest.param("--fee-rate", "-0.001", "fee_rate", id="negative-fee"),
    pytest.param("--fee-rate", "0.000000001", "fee_rate", id="fee-precision"),
])
def test_parameter_errors(tmp_path, flag, value, column):
    status, out = run(tmp_path, flags=(flag, value))
    assert status == 3
    assert_errors(out, f"E102_BAD_PARAMETER,0,{column}")


def test_parameter_order_and_precedence(tmp_path):
    out = tmp_path / "out"
    status = main(["https://example.com/x.csv", "--out", str(out),
                   "--fee-rate", "0.02", "--position-size", "0", "--starting-capital", "0"])
    assert status == 3
    assert_errors(out, "E102_BAD_PARAMETER,0,starting_capital",
                  "E102_BAD_PARAMETER,0,position_size", "E102_BAD_PARAMETER,0,fee_rate")


@pytest.mark.parametrize("fee_flags", [("--fee-rate", "-1e-3"), ("--fee-rate=-1e-3",)])
def test_parameter_that_looks_like_a_flag_is_validated(tmp_path, fee_flags):
    status, out = run(tmp_path, flags=(*fee_flags, "--starting-capital", "0"))
    assert status == 3
    assert_errors(out, "E102_BAD_PARAMETER,0,starting_capital",
                  "E102_BAD_PARAMETER,0,fee_rate")


@pytest.mark.parametrize("path", [
    pytest.param("https://example.com/x.csv", id="P03"),
    "http://example.com/x.csv", "s3://test/x.csv", "gs://test/x.csv",
    "ftp://example.com/x.csv", "file:///tmp/x.csv", "CUSTOM+git.1-://fixture",
])
def test_rejects_uri(tmp_path, path):
    out = tmp_path / "out"
    assert main([path, "--out", str(out)]) == 3
    assert_errors(out, "E103_INPUT_NOT_LOCAL,0,")


@pytest.mark.parametrize("path", [r"\\server\share\input.csv", "//server/share/input.csv"])
def test_rejects_unc_input(tmp_path, path):
    out = tmp_path / "out"
    assert main([path, "--out", str(out)]) == 3
    assert_errors(out, "E103_INPUT_NOT_LOCAL,0,")


@pytest.mark.parametrize("path", [r"\\server\share\out", "//server/share/out"])
def test_rejects_unc_output_without_filesystem_checks(monkeypatch, capsys, path):
    def unexpected_filesystem_call(*args, **kwargs):
        pytest.fail("UNC output must be rejected before checking or creating paths")

    with monkeypatch.context() as patch:
        patch.setattr(os.path, "realpath", unexpected_filesystem_call)
        patch.setattr(Path, "mkdir", unexpected_filesystem_call)
        assert main([str(BASIC), "--out", path]) == 3
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Output directory must be local" in captured.err


@pytest.mark.parametrize("kind", ["missing", "directory", "unreadable"])
def test_unreadable(tmp_path, monkeypatch, kind):
    source = tmp_path / "input"
    out = tmp_path / "out"
    if kind == "directory":
        source.mkdir()
    elif kind == "unreadable":
        source.touch()

        def deny_read(self):
            assert self == source
            raise PermissionError

        monkeypatch.setattr(Path, "read_bytes", deny_read)
    assert main([str(source), "--out", str(out)]) == 3
    monkeypatch.undo()
    assert_errors(out, "E104_INPUT_UNREADABLE,0,")


@pytest.mark.parametrize("name", ["fills.csv", "equity.csv", "summary.json", "errors.csv", "report.html"])
def test_refuses_output_named_like_input(tmp_path, capsys, name):
    source = tmp_path / name
    source.write_bytes(RAW)
    assert main([str(source), "--out", str(tmp_path)]) == 3
    assert source.read_bytes() == RAW
    assert list(tmp_path.iterdir()) == [source]
    assert f"Output {name} aliases the input file" in capsys.readouterr().err


@pytest.mark.parametrize("kind", ["hard", "symbolic"])
def test_refuses_output_link_to_input_on_failure(tmp_path, capsys, kind):
    source = tmp_path / "invalid.csv"
    source.write_bytes(b"")
    out = tmp_path / "out"
    out.mkdir()
    alias = out / "errors.csv"
    try:
        if kind == "hard":
            alias.hardlink_to(source)
        else:
            alias.symlink_to(source)
    except OSError as exc:
        pytest.skip(f"{kind} links not supported: {exc}")

    assert main([str(source), "--out", str(out)]) == 3
    assert source.read_bytes() == b""
    assert list(out.iterdir()) == [alias]
    assert "Output errors.csv aliases the input file" in capsys.readouterr().err


@pytest.mark.parametrize(("raw", "blocked"), [(RAW, "summary.json"), (b"", "errors.csv")])
def test_output_directory_collision_leaves_no_partial_files(tmp_path, capsys, raw, blocked):
    out = tmp_path / "out"
    (out / blocked).mkdir(parents=True)
    status, _ = run(tmp_path, raw)
    assert status == 3
    assert {path.name for path in out.iterdir()} == {blocked}
    assert "Cannot write backtest output" in capsys.readouterr().err


def test_replace_failure_restores_previous_files_and_removes_new_files(tmp_path, monkeypatch, capsys):
    out = tmp_path / "out"
    out.mkdir()
    (out / "fills.csv").write_bytes(b"previous fills\n")
    replace = os.replace

    def fail_on_summary(source, destination):
        if destination == out / "summary.json":
            raise PermissionError("test replacement failure")
        return replace(source, destination)

    monkeypatch.setattr(os, "replace", fail_on_summary)
    status, _ = run(tmp_path)
    assert status == 3
    assert {path.name for path in out.iterdir()} == {"fills.csv"}
    assert (out / "fills.csv").read_bytes() == b"previous fills\n"
    assert "test replacement failure" in capsys.readouterr().err


def test_e101_default_fixture(tmp_path):
    status, out = run(tmp_path, flags=("--starting-capital", "5000.00", "--html"))
    assert status == 4
    assert_errors(out, "E101_INSUFFICIENT_CASH,2,")


def test_later_e101_still_writes_no_partial_output(tmp_path):
    raw = edit((5, 7, "1"), (6, 2, "1000"), (6, 3, "1000"))
    status, out = run(tmp_path, raw)
    assert status == 4
    assert_errors(out, "E101_INSUFFICIENT_CASH,6,")


def test_cash_can_reach_zero_and_parameters_keep_raw_spelling(tmp_path):
    status, out = run(tmp_path, flags=("--starting-capital", "0005005", "--fee-rate", "0.00000000"))
    assert status == 0
    assert (out / "fills.csv").read_bytes().splitlines()[1].endswith(b",0.00,0.00")
    summary = json.loads((out / "summary.json").read_bytes())
    assert summary["parameters"] == {
        "fee_rate": "0.00000000", "position_size": "50", "starting_capital": "0005005",
    }


def test_max_price_width_is_accepted_and_price_spelling_is_retained(tmp_path):
    largest = "999999999999.99999999"
    raw = edit((3, 5, largest), (3, 3, largest))
    status, out = run(tmp_path, raw)
    assert status == 0
    assert (out / "equity.csv").read_bytes().splitlines()[3].split(b",")[3] == largest.encode()


def test_no_lookahead(tmp_path):
    status, base_out = run(tmp_path / "base")
    assert status == 0
    base_fills = (base_out / "fills.csv").read_bytes().splitlines()[1:]
    base_equity = (base_out / "equity.csv").read_bytes().splitlines()[1:]
    for row in range(2, 7):
        signal = "0" if RAW.splitlines()[row].endswith(b",1") else "1"
        changed = edit((row, 2, "102.50"), (row, 5, "102.75"), (row, 7, signal),
                       (row, 3, "106.00"), (row, 4, "99.00"))
        status, out = run(tmp_path / str(row), changed)
        assert status == 0
        cutoff = base_equity[row - 2].split(b",")[0]
        fills = (out / "fills.csv").read_bytes().splitlines()[1:]
        assert [fill for fill in fills if fill.split(b",")[2] <= cutoff] == [
            fill for fill in base_fills if fill.split(b",")[2] <= cutoff
        ]
        assert (out / "equity.csv").read_bytes().splitlines()[1:row] == base_equity[:row - 1]
    assert all(fill.split(b",")[1] < fill.split(b",")[2] for fill in base_fills)
    assert all(fill.split(b",")[1] != base_equity[-1].split(b",")[0] for fill in base_fills)


def test_first_peak_and_first_trough_win_ties(tmp_path):
    raw = edit((3, 5, "102.00"), (4, 5, "101.00"), (4, 4, "101.00"),
               (4, 7, "1"), (5, 5, "101.00"), (5, 4, "101.00"), (5, 7, "1"))
    status, out = run(tmp_path, raw)
    assert status == 0
    summary = json.loads((out / "summary.json").read_bytes())
    assert summary["max_drawdown"] == "0.004955"
    assert summary["max_drawdown_peak_timestamp"] == "2026-01-06T00:00:00Z"
    assert summary["max_drawdown_trough_timestamp"] == "2026-01-08T00:00:00Z"
    assert summary["final_position_units"] == "50"


def test_initial_capital_peak_has_no_timestamp(tmp_path):
    raw = edit((2, 5, "100.10"), (3, 5, "100.10"), (4, 5, "101.00"))
    status, out = run(tmp_path, raw)
    assert status == 0
    summary = json.loads((out / "summary.json").read_bytes())
    assert summary["max_drawdown_peak_timestamp"] == ""
    assert summary["max_drawdown_trough_timestamp"] == "2026-01-06T00:00:00Z"


def test_html_is_optional_standalone_and_uses_calculated_results(tmp_path):
    status, out = run(tmp_path, flags=("--html",))
    assert status == 0
    report = (out / "report.html").read_text(encoding="utf-8")
    assert report.startswith("<!doctype html>")
    assert "<polyline" in report
    assert "10199.77" in report
    assert "<td>BUY</td>" in report and "<td>SELL</td>" in report
    assert "Not trading or investment advice. No orders were placed." in report
    assert all(term not in report for term in ("http://", "https://", "<script", "src="))
    for name, checksum in OUTPUT_SHA.items():
        assert sha((out / name).read_bytes()) == checksum


def test_no_fills_has_constant_equity_and_no_drawdown(tmp_path):
    raw = edit(*((i, 7, "0") for i in range(1, 7)))
    status, out = run(tmp_path, raw, flags=("--html",))
    assert status == 0
    assert (out / "fills.csv").read_bytes().splitlines() == [
        b"fill_id,signal_timestamp,fill_timestamp,side,units,price,notional,fee,cash_after"
    ]
    summary = json.loads((out / "summary.json").read_bytes())
    assert summary["max_drawdown"] == "0.000000"
    assert summary["max_drawdown_peak_timestamp"] == summary["max_drawdown_trough_timestamp"] == ""
    assert "No simulated fills." in (out / "report.html").read_text(encoding="utf-8")


def test_deterministic_between_cli_processes(tmp_path):
    runner = """
import runpy, socket
def blocked(*args, **kwargs):
    raise AssertionError("CLI attempted to use sockets")
socket.socket = socket.create_connection = socket.getaddrinfo = blocked
runpy.run_module("quanttrading.backtest", run_name="__main__", alter_sys=True)
"""
    runs = []
    for seed, locale in (("1", "C"), ("1337", "en_US.UTF-8")):
        out = tmp_path / seed
        env = {**os.environ, "PYTHONHASHSEED": seed, "LC_ALL": locale, "PYTHONUTF8": "0"}
        result = subprocess.run(
            [sys.executable, "-c", runner, str(BASIC), "--out", str(out), "--html"],
            cwd=ROOT, env=env, capture_output=True,
        )
        assert result.returncode == 0, result.stderr.decode(errors="replace")
        runs.append({path.name: sha(path.read_bytes()) for path in out.iterdir()})
    assert runs[0] == runs[1]
