import asyncio
from os import environ
from subprocess import run
from sys import executable
from uuid import uuid4

import pytest
from arq import create_pool
from sqlalchemy import func, insert, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from backend import paper, runs
from backend.database import (
    candle_dead_letters, candle_outbox, candles, database_url, paper_orders, processed_candle_events,
)


@pytest.fixture
def replay_database():
    name = f"paper_test_{uuid4().hex}"
    url = make_url(database_url())

    async def execute(statement):
        engine = create_async_engine(url, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as connection:
                await connection.execute(text(statement))
        finally:
            await engine.dispose()

    asyncio.run(execute(f"CREATE DATABASE {name}"))
    try:
        dsn = url.set(database=name)
        run(
            [executable, "-m", "alembic", "-c", "backend/alembic.ini", "upgrade", "head"],
            env={**environ, "QT_DATABASE_URL": dsn.render_as_string(hide_password=False)}, check=True,
        )
        yield dsn
    finally:
        asyncio.run(execute(f"DROP DATABASE {name} WITH (FORCE)"))


class CrashAfterPublish:
    def __init__(self, redis):
        self.redis = redis

    async def xadd(self, *args):
        await self.redis.xadd(*args)
        raise RuntimeError("relay crashed before commit")


class CrashBeforeAck:
    def __init__(self, redis):
        self.redis = redis

    def __getattr__(self, name):
        return getattr(self.redis, name)

    async def xack(self, *_):
        raise RuntimeError("consumer crashed before ack")


async def scalar(engine, query):
    async with engine.connect() as connection:
        return await connection.scalar(query)


async def count(engine, table):
    return await scalar(engine, select(func.count()).select_from(table))


async def exercise_replay(engine, redis, stream):
    source = paper.replay_source()
    assert await paper.replay_candle(engine, source[0] | {"is_closed": False}, source) == 0
    assert await count(engine, candle_outbox) == 0
    assert not await scalar(engine, select(candles.c.is_closed))

    with pytest.raises(ValueError, match="Unrecoverable gap"):
        await paper.replay_candle(engine, source[2], [source[0], source[2]])
    assert await count(engine, candle_outbox) == 0
    assert not await scalar(engine, select(candles.c.is_closed))

    assert await paper.replay_candle(engine, source[0], source) == 1
    assert await scalar(engine, select(candles.c.is_closed))
    assert await paper.replay_candle(engine, source[0] | {"is_closed": False}, source) == 0
    assert await scalar(engine, select(candles.c.is_closed))
    with pytest.raises(RuntimeError, match="relay crashed"):
        await paper.relay_next(engine, CrashAfterPublish(redis), stream)
    assert await redis.xlen(stream) == 1
    assert await scalar(engine, select(candle_outbox.c.published_at)) is None

    assert await paper.relay_next(engine, redis, stream)
    assert not await paper.relay_next(engine, redis, stream)
    entries = await redis.xrange(stream)
    assert len(entries) == 2
    assert entries[0][0] != entries[1][0]
    assert entries[0][1] == entries[1][1]
    assert entries[0][1][b"type"] == b"candle.closed"

    with pytest.raises(RuntimeError, match="consumer crashed"):
        await paper.consume(engine, CrashBeforeAck(redis), "crashed", stream, limit=1)
    assert (await redis.xpending(stream, paper.GROUP))["pending"] == 1
    assert await count(engine, processed_candle_events) == 1
    assert await count(engine, paper_orders) == 1
    assert await paper.execute_paper(engine) == 0
    waiting = await paper.paper_report(engine)
    assert waiting[0]["fill_time"] is None

    assert await paper.consume(engine, redis, "restarted", stream, reclaim_idle_ms=0) == 2
    assert (await redis.xpending(stream, paper.GROUP))["pending"] == 0
    assert await count(engine, paper_orders) == 1
    assert await count(engine, processed_candle_events) == 1

    assert await paper.replay_candle(engine, source[-1], source) == len(source) - 1
    assert await count(engine, candles) == len(source)
    assert await count(engine, candle_outbox) == len(source)
    for _ in source[1:]:
        assert await paper.relay_next(engine, redis, stream)
    assert await paper.consume(engine, redis, "restarted", stream) == len(source) - 1
    assert await count(engine, processed_candle_events) == len(source)
    assert await paper.execute_paper(engine) == 2
    orders = await paper.paper_report(engine)
    assert [(order["side"], order["quantity"], order["price"]) for order in orders] == [
        ("BUY", "1", "100.10"), ("SELL", "1", "104.30"), ("BUY", "1", None),
    ]
    assert all(order["fill_time"] - order["signal_time"] == 900 for order in orders[:2])
    assert orders[-1]["signal_time"] == int(source[-1]["open_ts"].timestamp())
    assert orders[-1]["fill_time"] is None
    assert await paper.replay_candle(engine, source[-1], source) == 0
    assert not await paper.relay_next(engine, redis, stream)
    assert await paper.consume(engine, redis, "restarted", stream) == 0
    assert await paper.execute_paper(engine) == 0
    assert await paper.paper_report(engine) == orders


@pytest.mark.skipif(not environ.get("QT_TEST_API_URL"), reason="requires Compose TimescaleDB and Redis")
def test_synthetic_paper_replay_is_atomic_and_recoverable(replay_database):
    async def test():
        engine = create_async_engine(replay_database)
        redis = await create_pool(runs.redis_settings())
        stream = f"{paper.STREAM}:test:{uuid4()}"
        try:
            await exercise_replay(engine, redis, stream)
        finally:
            await redis.delete(stream)
            await redis.aclose()
            await engine.dispose()

    asyncio.run(test())


@pytest.mark.skipif(not environ.get("QT_TEST_API_URL"), reason="requires Compose TimescaleDB and Redis")
def test_poison_event_does_not_block_and_is_quarantined(replay_database):
    async def test():
        engine = create_async_engine(replay_database)
        redis = await create_pool(runs.redis_settings())
        stream = f"{paper.STREAM}:test:{uuid4()}"
        try:
            source = paper.replay_source()
            bad_event = {"id": uuid4(), **paper.identity(source[1])}
            async with engine.begin() as connection:
                await connection.execute(insert(candle_outbox).values(**bad_event))
            message_id = await redis.xadd(stream, paper.event_fields(bad_event))
            assert await paper.replay_candle(engine, source[0], source) == 1
            assert await paper.relay_next(engine, redis, stream)
            assert await paper.consume(engine, redis, "first", stream, max_deliveries=2) == 1
            assert await count(engine, paper_orders) == 1
            assert await count(engine, candle_dead_letters) == 0
            assert (await redis.xpending(stream, paper.GROUP))["pending"] == 1

            assert await paper.consume(engine, redis, "retry", stream, reclaim_idle_ms=0, max_deliveries=2) == 1
            async with engine.connect() as connection:
                row = (await connection.execute(select(candle_dead_letters))).one()
            assert (row.message_id, row.event_id, row.error_code, row.deliveries) == (
                message_id.decode(), bad_event["id"], "missing_closed_candle", 2,
            )
            assert (await redis.xpending(stream, paper.GROUP))["pending"] == 0
            assert await count(engine, processed_candle_events) == 1
        finally:
            await redis.delete(stream)
            await redis.aclose()
            await engine.dispose()

    asyncio.run(test())
