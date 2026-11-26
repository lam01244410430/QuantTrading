from os import environ

from sqlalchemy import (
    UUID, BigInteger, Boolean, Column, DateTime, ForeignKey, Index, MetaData,
    Numeric, SmallInteger, String, Table, func,
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


def database_url() -> str:
    return environ["QT_DATABASE_URL"]


def create_engine():
    return create_async_engine(database_url(), pool_pre_ping=True)
