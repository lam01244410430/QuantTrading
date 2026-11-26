from datetime import timedelta
from decimal import Decimal
from uuid import UUID, uuid4

from redis.exceptions import ResponseError
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert

from .database import (
    candle_dead_letters, candle_identity, candle_outbox, candles, paper_fills, paper_orders, processed_candle_events,
)
from .synthetic import decimal_text, fixture_rows

STREAM = "qt:synthetic:candles"
GROUP = "paper-strategy"
EVENT_TYPE = "candle.closed"
STEP = timedelta(minutes=15)
MAX_DELIVERIES = 3


class InvalidCandleEvent(ValueError):
    pass


def replay_source():
    return [row for row in fixture_rows() if row["timeframe"] == "15m"]


def identity(row):
    return {name: row[name] for name in candle_identity}


def matches(table, key):
    return and_(*(table.c[name] == value for name, value in key.items()))


async def save_candle(connection, candle):
    statement = insert(candles).values(candle)
    await connection.execute(statement.on_conflict_do_update(
        index_elements=list(candle_identity),
        set_={name: statement.excluded[name] for name in ("open", "high", "low", "close", "volume", "is_closed", "signal")},
        where=candles.c.is_closed.is_(False),
    ))
    if not candle["is_closed"]:
        return 0
    event = await connection.scalar(insert(candle_outbox).values(id=uuid4(), **identity(candle)).on_conflict_do_nothing(
        index_elements=list(candle_identity),
    ).returning(candle_outbox.c.id))
    return int(event is not None)


async def replay_candle(engine, incoming, source):
    series = identity(incoming)
    through = series.pop("open_ts")
    history = {
        row["open_ts"]: row for row in source
        if all(row[name] == value for name, value in series.items()) and row["is_closed"]
    }
    if through not in history:
        raise ValueError("Candle is outside the synthetic replay source")
    async with engine.begin() as connection:
        if not incoming["is_closed"]:
            return await save_candle(connection, incoming)
        prior = set((await connection.scalars(select(candle_outbox.c.open_ts).where(
            matches(candle_outbox, series), candle_outbox.c.open_ts < through,
        ))).all())
        count = 0
        expected = min(history)
        while expected < through:
            if expected not in history:
                raise ValueError("Unrecoverable gap in synthetic replay source")
            if expected not in prior:
                count += await save_candle(connection, history[expected])
            expected += STEP
        return count + await save_candle(connection, incoming)


def event_fields(row):
    data = identity(row)
    data["open_ts"] = data["open_ts"].isoformat()
    return {"type": EVENT_TYPE, "event_id": str(row["id"]), **data}


async def relay_next(engine, redis, stream=STREAM):
    async with engine.begin() as connection:
        cursor = await connection.execute(select(candle_outbox).where(
            candle_outbox.c.published_at.is_(None),
        ).order_by(candle_outbox.c.open_ts, candle_outbox.c.id).limit(1).with_for_update(skip_locked=True))
        event = cursor.mappings().one_or_none()
        if event is None:
            return False
        await redis.xadd(stream, event_fields(event))
        await connection.execute(update(candle_outbox).where(
            candle_outbox.c.id == event["id"],
        ).values(published_at=func.now()))
    return True


def strategy_side(previous, current):
    if previous == current:
        return None
    return "BUY" if current else "SELL"


async def process_event(engine, event_id):
    async with engine.begin() as connection:
        result = await connection.execute(select(candle_outbox).where(candle_outbox.c.id == event_id))
        event = result.mappings().one_or_none()
        if event is None:
            raise InvalidCandleEvent("missing_outbox_event")
        inserted = await connection.scalar(insert(processed_candle_events).values(event_id=event_id)
                                           .on_conflict_do_nothing().returning(processed_candle_events.c.event_id))
        if inserted is None:
            return
        current = identity(event)
        prior = current | {"open_ts": current["open_ts"] - STEP}
        signal = await connection.scalar(select(candles.c.signal).where(
            matches(candles, current), candles.c.is_closed.is_(True),
        ))
        if signal is None:
            raise InvalidCandleEvent("missing_closed_candle")
        previous = await connection.scalar(select(candles.c.signal).where(
            matches(candles, prior), candles.c.is_closed.is_(True),
        ))
        if previous is None and current["open_ts"] != replay_source()[0]["open_ts"]:
            raise InvalidCandleEvent("candle_gap")
        side = strategy_side(previous or 0, signal)
        if side is not None:
            await connection.execute(insert(paper_orders).values(
                event_id=event_id, side=side, signal_time=current["open_ts"], quantity=Decimal("1"),
            ))


async def ensure_group(redis, stream):
    try:
        await redis.xgroup_create(stream, GROUP, id="0-0", mkstream=True)
    except ResponseError as exc:
        if not str(exc).startswith("BUSYGROUP"):
            raise


def redis_text(value):
    return value.decode() if isinstance(value, bytes) else value


async def consume(engine, redis, consumer, stream=STREAM, reclaim_idle_ms=30_000, limit=100,
                  max_deliveries=MAX_DELIVERIES):
    if max_deliveries < 1:
        raise ValueError("max_deliveries must be at least 1")
    await ensure_group(redis, stream)
    acked, seen, start = 0, 0, "0-0"
    while seen < limit:
        start, messages, _ = await redis.xautoclaim(
            stream, GROUP, consumer, reclaim_idle_ms, start_id=start, count=limit - seen,
        )
        for message_id, message in messages:
            acked += await consume_message(engine, redis, stream, message_id, message, max_deliveries)
            seen += 1
        if start in ("0-0", b"0-0"):
            break
    if seen < limit:
        streams = await redis.xreadgroup(GROUP, consumer, {stream: ">"}, count=limit - seen)
        for _, messages in streams:
            for message_id, message in messages:
                acked += await consume_message(engine, redis, stream, message_id, message, max_deliveries)
    return acked


def parse_message(values):
    try:
        message = {redis_text(key): redis_text(value) for key, value in values.items()}
        event_id = UUID(message["event_id"])
        return event_id, None if message.get("type") == EVENT_TYPE else "invalid_event_type"
    except (KeyError, ValueError):
        return None, "invalid_event_payload"


async def consume_message(engine, redis, stream, message_id, values, max_deliveries):
    event_id, error = parse_message(values)
    key = {"stream": stream, "message_id": redis_text(message_id)}
    quarantine = matches(candle_dead_letters, key)
    if event_id is not None:
        quarantine = or_(quarantine, candle_dead_letters.c.event_id == event_id)
    async with engine.connect() as connection:
        quarantined = await connection.scalar(select(candle_dead_letters.c.message_id).where(quarantine).limit(1))
    if quarantined is None:
        if error is None:
            try:
                await process_event(engine, event_id)
            except InvalidCandleEvent as exc:
                error = str(exc)
        if error is not None:
            pending = await redis.xpending_range(stream, GROUP, message_id, message_id, 1)
            if not pending or pending[0]["times_delivered"] < max_deliveries:
                return 0
            async with engine.begin() as connection:
                await connection.execute(insert(candle_dead_letters).values(
                    **key, event_id=event_id, error_code=error, deliveries=pending[0]["times_delivered"],
                ).on_conflict_do_nothing())
    return await redis.xack(stream, GROUP, message_id)


async def execute_paper(engine):
    later = candle_outbox.alias("next_closed")
    series = candle_identity[:-1]
    next_closed = and_(
        *(later.c[name] == candle_outbox.c[name] for name in series),
        later.c.open_ts == candle_outbox.c.open_ts + STEP,
    )
    price_bar = and_(
        *(candles.c[name] == later.c[name] for name in candle_identity),
        candles.c.is_closed.is_(True),
    )
    async with engine.begin() as connection:
        result = await connection.execute(select(paper_orders.c.event_id, later.c.open_ts, candles.c.open).select_from(
            paper_orders.join(candle_outbox).join(later, next_closed).join(candles, price_bar).outerjoin(paper_fills),
        ).where(paper_fills.c.order_id.is_(None)).order_by(paper_orders.c.signal_time)
            .with_for_update(of=paper_orders, skip_locked=True))
        fills = [{"order_id": order, "fill_time": ts, "price": price} for order, ts, price in result]
        if fills:
            await connection.execute(insert(paper_fills).on_conflict_do_nothing(), fills)
    return len(fills)


async def paper_report(engine):
    async with engine.connect() as connection:
        result = await connection.execute(select(paper_orders, paper_fills.c.fill_time, paper_fills.c.price)
                                          .outerjoin(paper_fills).order_by(paper_orders.c.signal_time))
        return [{
            "id": str(row.event_id),
            "side": row.side,
            "quantity": decimal_text(row.quantity),
            "signal_time": int(row.signal_time.timestamp()),
            "fill_time": int(row.fill_time.timestamp()) if row.fill_time is not None else None,
            "price": decimal_text(row.price) if row.price is not None else None,
        } for row in result]
