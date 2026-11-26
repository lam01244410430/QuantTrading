import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0001_synthetic_slice"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")
    op.create_table(
        "admins",
        sa.Column("username", sa.String(128), primary_key=True),
        sa.Column("password_hash", sa.String(128), nullable=False),
    )
    op.create_table(
        "admin_sessions",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("username", sa.String(128), sa.ForeignKey("admins.username", ondelete="CASCADE"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_admin_sessions_expires_at", "admin_sessions", ["expires_at"])
    op.create_table(
        "candles",
        sa.Column("exchange", sa.String(32), primary_key=True),
        sa.Column("market", sa.String(32), primary_key=True),
        sa.Column("symbol", sa.String(16), primary_key=True),
        sa.Column("timeframe", sa.String(8), primary_key=True),
        sa.Column("open_ts", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("open", sa.Numeric, nullable=False),
        sa.Column("high", sa.Numeric, nullable=False),
        sa.Column("low", sa.Numeric, nullable=False),
        sa.Column("close", sa.Numeric, nullable=False),
        sa.Column("volume", sa.Numeric, nullable=False),
        sa.Column("is_closed", sa.Boolean, nullable=False),
        sa.Column("signal", sa.SmallInteger, nullable=False),
    )
    op.execute("SELECT create_hypertable('candles', by_range('open_ts'))")
    op.create_table(
        "backtest_runs",
        sa.Column("id", sa.UUID, primary_key=True),
        sa.Column("username", sa.String(128), sa.ForeignKey("admins.username", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("request", JSONB, nullable=False),
        sa.Column("result", JSONB),
        sa.Column("error", sa.String(64)),
    )
    op.create_index("ix_backtest_runs_owner_created", "backtest_runs", ["username", "created_at", "id"])


def downgrade():
    op.drop_table("backtest_runs")
    op.drop_table("candles")
    op.drop_table("admin_sessions")
    op.drop_table("admins")
