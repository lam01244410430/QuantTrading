import sqlalchemy as sa
from alembic import op

revision = "0003_candle_dead_letters"
down_revision = "0002_synthetic_paper"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "candle_dead_letters",
        sa.Column("stream", sa.String(128), primary_key=True),
        sa.Column("message_id", sa.String(64), primary_key=True),
        sa.Column("event_id", sa.UUID, index=True),
        sa.Column("error_code", sa.String(32), nullable=False),
        sa.Column("deliveries", sa.Integer, nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade():
    op.drop_table("candle_dead_letters")
