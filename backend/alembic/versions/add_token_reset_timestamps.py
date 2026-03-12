"""Add last_daily_reset and last_monthly_reset columns to agents table.

Revision ID: add_token_reset_timestamps
"""

from alembic import op

revision = "add_token_reset_timestamps"
down_revision = "add_quota_fields"
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.execute("ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_daily_reset TIMESTAMP WITH TIME ZONE")
    op.execute("ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_monthly_reset TIMESTAMP WITH TIME ZONE")

def downgrade() -> None:
    pass
