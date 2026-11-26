import sqlalchemy as sa
from alembic import op

revision = "0004_paper_fill_fee"
down_revision = "0003_candle_dead_letters"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("paper_fills", sa.Column("fee", sa.Numeric))
    op.execute(
        "UPDATE paper_fills SET fee = round(paper_fills.price * paper_orders.quantity * 0.001, 2) "
        "FROM paper_orders WHERE paper_fills.order_id = paper_orders.event_id"
    )
    op.alter_column("paper_fills", "fee", nullable=False)


def downgrade():
    op.drop_column("paper_fills", "fee")
