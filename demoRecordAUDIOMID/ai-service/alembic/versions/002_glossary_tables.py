"""Add glossary tables (skeleton)

Revision ID: 002
Revises: 001
Create Date: 2026-04-28 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "glossary_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("term", sa.String(length=255), nullable=False),
        sa.Column("domain", sa.String(length=100), nullable=True),
        sa.Column("normalized", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("term", "domain", name="uq_glossary_term_domain"),
    )
    op.create_index(
        "ix_glossary_entries_domain", "glossary_entries", ["domain"], unique=False
    )

    op.create_table(
        "glossary_versions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("domain", sa.String(length=100), nullable=True),
        sa.Column("version_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("version_hash", name="uq_glossary_version_hash"),
    )


def downgrade() -> None:
    op.drop_table("glossary_versions")
    op.drop_index("ix_glossary_entries_domain", table_name="glossary_entries")
    op.drop_table("glossary_entries")
