from decimal import Context, Decimal, DivisionByZero, InvalidOperation, Overflow, ROUND_HALF_UP, localcontext

from .constants import CONTRACT_ID, DISCLAIMER
from .validation import Issue, Rejected

CENT = Decimal("0.01")
DRAWDOWN_UNIT = Decimal("0.000001")
ACCOUNTING = Context(prec=34, rounding=ROUND_HALF_UP,
                     traps=[InvalidOperation, DivisionByZero, Overflow])


def _money(value):
    return format(value.quantize(CENT), "f")


def _drawdown(value):
    return format(value.quantize(DRAWDOWN_UNIT), "f")


def simulate(bars, params, input_file, input_sha256):
    with localcontext(ACCOUNTING):
        return _simulate(bars, params, input_file, input_sha256)


def _simulate(bars, params, input_file, input_sha256):
    cash = peak = params.starting_capital
    total_fees = max_drawdown = Decimal(0)
    peak_timestamp = max_peak = max_trough = ""
    position = 0
    previous = None
    fills = []
    equity_rows = []
    for row, bar in enumerate(bars, 1):
        if previous is not None:
            target = previous.signal * params.position_size
            if target != position:
                notional = bar.open * params.position_size
                fee = (notional * params.fee_rate).quantize(CENT)
                if target:
                    if notional + fee > cash:
                        raise Rejected(4, Issue("E101_INSUFFICIENT_CASH", row))
                    cash -= notional + fee
                    side = "BUY"
                else:
                    cash += notional - fee
                    side = "SELL"
                position = target
                total_fees += fee
                fills.append((str(len(fills) + 1), previous.timestamp, bar.timestamp,
                              side, str(params.position_size), bar.open_text, _money(notional),
                              _money(fee), _money(cash)))
        equity = cash + position * bar.close
        if equity > peak:
            peak = equity
            peak_timestamp = bar.timestamp
        drawdown = (peak - equity) / peak
        if drawdown > max_drawdown:
            max_drawdown = drawdown
            max_peak, max_trough = peak_timestamp, bar.timestamp
        equity_rows.append((bar.timestamp, _money(cash), str(position), bar.close_text,
                            _money(equity), _money(peak), _drawdown(drawdown)))
        previous = bar

    net_pnl = equity - params.starting_capital
    summary = {
        "bars": str(len(bars)),
        "contract_id": CONTRACT_ID,
        "disclaimer": DISCLAIMER,
        "fills": str(len(fills)),
        "final_equity": _money(equity),
        "final_position_units": str(position),
        "gross_pnl": _money(net_pnl + total_fees),
        "input_file": input_file,
        "input_sha256": input_sha256,
        "max_drawdown": _drawdown(max_drawdown),
        "max_drawdown_peak_timestamp": max_peak,
        "max_drawdown_trough_timestamp": max_trough,
        "net_pnl": _money(net_pnl),
        "parameters": {
            "fee_rate": params.fee_rate_text,
            "position_size": str(params.position_size),
            "starting_capital": params.starting_capital_text,
        },
        "symbol": bars[0].symbol,
        "total_fees": _money(total_fees),
    }
    return fills, equity_rows, summary
