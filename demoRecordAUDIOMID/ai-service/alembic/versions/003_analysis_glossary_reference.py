"""Add glossary reference columns to analysis

Revision ID: 003
Revises: 002
Create Date: 2026-04-29 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "analysis", sa.Column("glossary_domain", sa.String(length=100), nullable=True)
    )
    op.add_column(
        "analysis", sa.Column("glossary_version_id", sa.Integer(), nullable=True)
    )
    op.add_column(
        "analysis",
        sa.Column("glossary_version_hash", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("analysis", "glossary_version_hash")
    op.drop_column("analysis", "glossary_version_id")
    op.drop_column("analysis", "glossary_domain")
