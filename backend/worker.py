import asyncio
from datetime import datetime
from hashlib import sha256
from uuid import UUID

from quanttrading.constants import EQUITY_COLUMNS, FILL_COLUMNS
from quanttrading.engine import simulate
from quanttrading.validation import Rejected, parameters, validate

from . import runs
from .database import candles, create_engine
from .schemas import BacktestRequest, BacktestResult
from .synthetic import FIXTURE, closed_series, source_bytes


def unix_time(value: str) -> int | None:
    return int(datetime.fromisoformat(value).timestamp()) if value else None


def simulate_result(raw: bytes, request: BacktestRequest) -> BacktestResult:
    filename = FIXTURE.name if request.interval == "1d" else "fixture_v1_basic_synthetic_15m.csv"
    fills, equity, summary = simulate(
        validate(raw),
        parameters(request.starting_capital, request.position_size, request.fee_rate),
        filename,
        sha256(raw).hexdigest(),
    )
    summary["max_drawdown_peak_time"] = unix_time(summary.pop("max_drawdown_peak_timestamp"))
    summary["max_drawdown_trough_time"] = unix_time(summary.pop("max_drawdown_trough_timestamp"))

    points = []
    for row in equity:
        point = dict(zip(EQUITY_COLUMNS, row, strict=True))
        point["time"] = unix_time(point.pop("timestamp"))
        points.append(point)

    executions = []
    for row in fills:
        fill = dict(zip(FILL_COLUMNS, row, strict=True))
        fill["id"] = int(fill.pop("fill_id"))
        fill["signal_time"] = unix_time(fill.pop("signal_timestamp"))
        fill["fill_time"] = unix_time(fill.pop("fill_timestamp"))
        executions.append(fill)
    return BacktestResult.model_validate({"summary": summary, "equity_curve": points, "fills": executions})


async def run_backtest(ctx, run_id: str) -> None:
    engine = ctx["engine"]
    rid = UUID(run_id)
    request = await runs.claim_run(engine, rid)
    if request is None:
        return
    try:
        async with asyncio.timeout(runs.JOB_TIMEOUT):
            query = closed_series(request.symbol, request.interval).order_by(candles.c.open_ts)
            async with engine.connect() as connection:
                rows = (await connection.execute(query)).all()
            result = await asyncio.to_thread(simulate_result, source_bytes(rows), request)
    except Rejected as exc:
        await runs.finish_run(engine, rid, error=exc.issues[0].code)
    except TimeoutError:
        await runs.finish_run(engine, rid, error="job_timeout")
    else:
        await runs.finish_run(engine, rid, result=result.model_dump(mode="json"))


async def reconcile(ctx) -> None:
    await runs.reap_runs(ctx["engine"])


async def startup(ctx) -> None:
    ctx["engine"] = create_engine()
    await reconcile(ctx)


async def shutdown(ctx) -> None:
    await ctx["engine"].dispose()
