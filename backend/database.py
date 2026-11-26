from os import environ

from sqlalchemy import (
    UUID, BigInteger, Boolean, CheckConstraint, Column, DateTime, ForeignKey,
    Index, MetaData, Numeric, SmallInteger, String, Table, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import create_async_engine

metadata = MetaData()
admins = Table(
    "admins",
    metadata,
    Column("username", String(128), primary_key=True),
    Column("password_hash", String(128), nullable=False),
)
sessions = Table(
    "admin_sessions",
    metadata,
    Column("id", String(64), primary_key=True),
    Column("username", ForeignKey("admins.username", ondelete="CASCADE"), nullable=False),
    Column("expires_at", DateTime(timezone=True), nullable=False, index=True),
)
candles = Table(
    "candles",
    metadata,
    Column("exchange", String(32), primary_key=True),
    Column("market", String(32), primary_key=True),
    Column("symbol", String(16), primary_key=True),
    Column("timeframe", String(8), primary_key=True),
    Column("open_ts", DateTime(timezone=True), primary_key=True),
    Column("open", Numeric, nullable=False),
    Column("high", Numeric, nullable=False),
    Column("low", Numeric, nullable=False),
    Column("close", Numeric, nullable=False),
    Column("volume", Numeric, nullable=False),
    Column("is_closed", Boolean, nullable=False),
    Column("signal", SmallInteger, nullable=False),
)
backtests = Table(
    "backtest_runs",
    metadata,
    Column("id", UUID, primary_key=True),
    Column("username", ForeignKey("admins.username", ondelete="CASCADE"), nullable=False),
    Column("status", String(12), nullable=False),
    Column("created_at", DateTime(timezone=True), server_default=func.now(), nullable=False),
    Column("started_at", DateTime(timezone=True)),
    Column("request", JSONB, nullable=False),
    Column("result", JSONB(none_as_null=True)),
    Column("error", String(64)),
)
Index("ix_backtest_runs_owner_created", backtests.c.username, backtests.c.created_at, backtests.c.id)

candle_identity = ("exchange", "market", "symbol", "timeframe", "open_ts")
candle_outbox = Table(
    "candle_outbox",
    metadata,
    Column("id", UUID, primary_key=True),
    Column("exchange", String(32), nullable=False),
    Column("market", String(32), nullable=False),
    Column("symbol", String(16), nullable=False),
    Column("timeframe", String(8), nullable=False),
    Column("open_ts", DateTime(timezone=True), nullable=False),
    Column("published_at", DateTime(timezone=True)),
    UniqueConstraint(*candle_identity),
)
processed_candle_events = Table(
    "processed_candle_events",
    metadata,
    Column("event_id", ForeignKey("candle_outbox.id"), primary_key=True),
)
paper_orders = Table(
    "paper_orders",
    metadata,
    Column("event_id", ForeignKey("candle_outbox.id"), primary_key=True),
    Column("side", String(4), nullable=False),
    Column("signal_time", DateTime(timezone=True), nullable=False),
    Column("quantity", Numeric, nullable=False),
    CheckConstraint("side IN ('BUY', 'SELL')"),
    CheckConstraint("quantity > 0"),
)
paper_fills = Table(
    "paper_fills",
    metadata,
    Column("order_id", ForeignKey("paper_orders.event_id"), primary_key=True),
    Column("fill_time", DateTime(timezone=True), nullable=False),
    Column("price", Numeric, nullable=False),
    CheckConstraint("price > 0"),
)


def database_url() -> str:
    return environ["QT_DATABASE_URL"]


def create_engine():
    return create_async_engine(database_url(), pool_pre_ping=True)
