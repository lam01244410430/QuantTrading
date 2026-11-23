import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from .constants import COLUMNS, MAX_PRICE_INTEGER_DIGITS

URI = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
EXTENDED_DRIVE = re.compile(r"^(?:\\\\\?\\|//\?/)[A-Za-z]:[\\/]")
TIMESTAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
SYMBOL = re.compile(r"[A-Z0-9._-]{1,16}")
PRICE = re.compile(r"-?[0-9]{1,%d}(\.[0-9]{1,8})?" % MAX_PRICE_INTEGER_DIGITS)
VOLUME = re.compile(r"-?[0-9]+")
CAPITAL = re.compile(r"[0-9]+(\.[0-9]{1,2})?")
SIZE = re.compile(r"[1-9][0-9]*")
FEE = re.compile(r"[0-9]+(\.[0-9]{1,8})?")
MISSING = {"", "nan", "null", "na", "none", "n/a"}
COLUMN_INDEX = {name: i for i, name in enumerate(("", *COLUMNS))}


@dataclass(frozen=True)
class Issue:
    code: str
    row: int = 0
    column: str = ""


class Rejected(Exception):
    def __init__(self, exit_code, *issues):
        super().__init__(*(issue.code for issue in issues))
        self.exit_code = exit_code
        self.issues = issues


@dataclass(frozen=True)
class Parameters:
    starting_capital: Decimal
    position_size: int
    fee_rate: Decimal
    fee_rate_text: str


@dataclass(frozen=True)
class Bar:
    timestamp: str
    symbol: str
    open: Decimal
    close: Decimal
    open_text: str
    close_text: str
    signal: int


def parameters(starting_capital, position_size, fee_rate):
    issues = []
    capital = Decimal(starting_capital) if CAPITAL.fullmatch(starting_capital) else None
    size = int(position_size) if len(position_size) <= 7 and SIZE.fullmatch(position_size) else None
    fee = Decimal(fee_rate) if FEE.fullmatch(fee_rate) else None
    if capital is None or not 0 < capital <= Decimal("1000000000.00"):
        issues.append(Issue("E102_BAD_PARAMETER", column="starting_capital"))
    if size is None or not 1 <= size <= 1000000:
        issues.append(Issue("E102_BAD_PARAMETER", column="position_size"))
    if fee is None or not 0 <= fee <= Decimal("0.01"):
        issues.append(Issue("E102_BAD_PARAMETER", column="fee_rate"))
    if issues:
        raise Rejected(3, *issues)
    return Parameters(capital, size, fee, fee_rate)


def is_local_path(path):
    if len(path) >= 2 and all(separator in "\\/" for separator in path[:2]):
        return EXTENDED_DRIVE.match(path) is not None
    return URI.match(path) is None


def read_input(input_path):
    if not is_local_path(input_path):
        raise Rejected(3, Issue("E103_INPUT_NOT_LOCAL"))
    path = Path(input_path)
    try:
        if not path.is_file():
            raise OSError
        return path.read_bytes()
    except (OSError, ValueError) as exc:
        raise Rejected(3, Issue("E104_INPUT_UNREADABLE")) from exc


def _lines(raw):
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise Rejected(2, Issue("E017_BAD_ENCODING")) from exc
    if source.startswith("\ufeff"):
        raise Rejected(2, Issue("E017_BAD_ENCODING"))
    *terminated, tail = source.split("\n")
    lines = [line.removesuffix("\r") for line in terminated]
    if tail or not lines:
        lines.append(tail)
    if not lines[0]:
        raise Rejected(2, Issue("E001_FILE_EMPTY"))
    if tuple(lines[0].split(",")) != COLUMNS:
        raise Rejected(2, Issue("E002_HEADER_MISMATCH"))
    return lines[1:]


def _parse_field(column, field):
    if field.casefold() in MISSING or field.isspace():
        return None, "E005_MISSING_VALUE"
    if column == "timestamp":
        if TIMESTAMP.fullmatch(field):
            try:
                datetime.fromisoformat(field[:-1])
            except ValueError:
                pass
            else:
                return field, None
        return None, "E006_BAD_TIMESTAMP"
    if column == "symbol":
        if SYMBOL.fullmatch(field):
            return field, None
        return None, "E009_SYMBOL_INVALID"
    if column == "signal":
        if field in ("0", "1"):
            return int(field), None
        return None, "E016_BAD_SIGNAL"
    if column == "volume":
        if not VOLUME.fullmatch(field):
            return None, "E011_BAD_NUMBER"
        if field.startswith("-"):
            return None, "E015_NEGATIVE_VOLUME"
        return int(Decimal(field)), None
    if not PRICE.fullmatch(field):
        return None, "E011_BAD_NUMBER"
    price = Decimal(field)
    if price <= 0:
        return None, "E012_NON_POSITIVE_PRICE"
    return price, None


def validate(raw):
    lines = _lines(raw)
    issues = [Issue("E003_TOO_FEW_ROWS")] if len(lines) < 2 else []
    bars = []
    first_symbol = previous = None
    seen = set()
    for row, line in enumerate(lines, 1):
        fields = line.split(",")
        if len(fields) != len(COLUMNS):
            issues.append(Issue("E004_FIELD_COUNT", row))
            continue
        values = {}
        for column, field in zip(COLUMNS, fields):
            value, code = _parse_field(column, field)
            if code:
                issues.append(Issue(code, row, column))
            else:
                values[column] = value

        timestamp = values.get("timestamp")
        if timestamp is not None:
            if timestamp in seen:
                issues.append(Issue("E007_DUPLICATE_TIMESTAMP", row, "timestamp"))
            elif previous is not None and timestamp < previous:
                issues.append(Issue("E008_OUT_OF_ORDER", row, "timestamp"))
            seen.add(timestamp)
            previous = timestamp

        symbol = values.get("symbol")
        if symbol is not None:
            if first_symbol is None:
                first_symbol = symbol
            elif symbol != first_symbol:
                issues.append(Issue("E010_SYMBOL_MISMATCH", row, "symbol"))

        if all(column in values for column in COLUMNS[2:6]):
            low, high = values["low"], values["high"]
            if high < low:
                issues.append(Issue("E013_HIGH_LT_LOW", row, "high"))
            else:
                for column in ("open", "close"):
                    if not low <= values[column] <= high:
                        issues.append(Issue("E014_OPEN_CLOSE_OUT_OF_RANGE", row, column))

        if len(values) == len(COLUMNS):
            bars.append(Bar(timestamp, symbol, values["open"], values["close"],
                            fields[2], fields[5], values["signal"]))

    if issues:
        issues.sort(key=lambda issue: (issue.row, COLUMN_INDEX[issue.column], issue.code))
        raise Rejected(2, *issues)
    return bars
