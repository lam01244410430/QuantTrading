import sqlalchemy as sa
from alembic import op

revision = "0002_synthetic_paper"
down_revision = "0001_synthetic_slice"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "candle_outbox",
        sa.Column("id", sa.UUID, primary_key=True),
        sa.Column("exchange", sa.String(32), nullable=False),
        sa.Column("market", sa.String(32), nullable=False),
        sa.Column("symbol", sa.String(16), nullable=False),
        sa.Column("timeframe", sa.String(8), nullable=False),
        sa.Column("open_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("exchange", "market", "symbol", "timeframe", "open_ts"),
    )
    op.create_table(
        "processed_candle_events",
        sa.Column("event_id", sa.UUID, sa.ForeignKey("candle_outbox.id"), primary_key=True),
    )
    op.create_table(
        "paper_orders",
        sa.Column("event_id", sa.UUID, sa.ForeignKey("candle_outbox.id"), primary_key=True),
        sa.Column("side", sa.String(4), nullable=False),
        sa.Column("signal_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("quantity", sa.Numeric, nullable=False),
        sa.CheckConstraint("side IN ('BUY', 'SELL')"),
        sa.CheckConstraint("quantity > 0"),
    )
    op.create_table(
        "paper_fills",
        sa.Column("order_id", sa.UUID, sa.ForeignKey("paper_orders.event_id"), primary_key=True),
        sa.Column("fill_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("price", sa.Numeric, nullable=False),
        sa.CheckConstraint("price > 0"),
    )


def downgrade():
    op.drop_table("paper_fills")
    op.drop_table("paper_orders")
    op.drop_table("processed_candle_events")
    op.drop_table("candle_outbox")
