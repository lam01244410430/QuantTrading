import json
from datetime import datetime, timedelta, timezone
from os import environ
from uuid import UUID

from arq.connections import ArqRedis, RedisSettings
from sqlalchemy import and_, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from .database import backtests
from .schemas import BacktestDetail, BacktestList, BacktestRequest, BacktestRun

QUEUE_TTL = 120
JOB_TIMEOUT = 20
RUN_TTL = 60
REAP_INTERVAL = 15
JOB_NAME = "run_backtest"


def redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(environ["QT_REDIS_URL"])


def serialize_job(data) -> bytes:
    return json.dumps(data).encode()


async def create_run(
    engine: AsyncEngine, run_id: UUID, username: str, request: BacktestRequest,
) -> BacktestRun:
    async with engine.begin() as connection:
        result = await connection.execute(insert(backtests).values(
            id=run_id, username=username, status="queued", request=request.model_dump(mode="json"),
        ).returning(backtests.c.created_at))
        run = BacktestRun(id=run_id, request=request, status="queued", created_at=result.scalar_one())
    return run


async def enqueue_run(redis: ArqRedis, run_id: UUID):
    return await redis.enqueue_job(JOB_NAME, str(run_id), _job_id=str(run_id), _expires=QUEUE_TTL)


async def fail_queued(engine: AsyncEngine, run_id: UUID, error: str) -> None:
    async with engine.begin() as connection:
        await connection.execute(update(backtests).where(
            backtests.c.id == run_id, backtests.c.status == "queued",
        ).values(status="failed", error=error))


def stale_rows():
    now = datetime.now(timezone.utc)
    return or_(
        and_(backtests.c.status == "queued", backtests.c.created_at <= now - timedelta(seconds=QUEUE_TTL)),
        and_(backtests.c.status == "running", backtests.c.started_at <= now - timedelta(seconds=RUN_TTL)),
    )


def expire_runs():
    return update(backtests).where(stale_rows()).values(status="failed", error="job_expired")


async def reap_runs(engine: AsyncEngine) -> None:
    async with engine.begin() as connection:
        await connection.execute(expire_runs())


async def list_runs(engine: AsyncEngine, username: str, limit: int) -> BacktestList:
    owner = backtests.c.username == username
    async with engine.begin() as connection:
        await connection.execute(expire_runs().where(owner))
        result = await connection.execute(
            select(
                backtests.c.id, backtests.c.status, backtests.c.created_at, backtests.c.request,
            ).where(owner).order_by(backtests.c.created_at.desc(), backtests.c.id.desc()).limit(limit)
        )
        return BacktestList(runs=[BacktestRun.model_validate(row) for row in result.mappings()])


async def get_run(engine: AsyncEngine, username: str, run_id: UUID) -> BacktestDetail | None:
    selector = (backtests.c.username == username, backtests.c.id == run_id)
    async with engine.begin() as connection:
        await connection.execute(expire_runs().where(*selector))
        result = await connection.execute(select(backtests).where(*selector))
        row = result.mappings().one_or_none()
        return BacktestDetail.model_validate(row) if row is not None else None


async def claim_run(engine: AsyncEngine, run_id: UUID) -> BacktestRequest | None:
    now = datetime.now(timezone.utc)
    async with engine.begin() as connection:
        result = await connection.execute(update(backtests).where(
            backtests.c.id == run_id, backtests.c.status == "queued",
            backtests.c.created_at > now - timedelta(seconds=QUEUE_TTL),
        ).values(status="running", started_at=now).returning(backtests.c.request))
        request = result.scalar_one_or_none()
    return BacktestRequest.model_validate(request) if request is not None else None


async def finish_run(engine: AsyncEngine, run_id: UUID, *, result=None, error=None) -> None:
    async with engine.begin() as connection:
        await connection.execute(update(backtests).where(
            backtests.c.id == run_id, backtests.c.status == "running", ~stale_rows(),
        ).values(status="succeeded" if result is not None else "failed", result=result, error=error))
