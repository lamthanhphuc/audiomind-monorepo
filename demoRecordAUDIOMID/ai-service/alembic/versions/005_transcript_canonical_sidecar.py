"""Add canonical transcript sidecar columns

Revision ID: 005
Revises: 004
Create Date: 2026-06-01 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def _existing_columns(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {column["name"] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    columns = _existing_columns("transcripts")

    if "raw_transcript_hash" not in columns:
        op.add_column(
            "transcripts",
            sa.Column("raw_transcript_hash", sa.String(length=64), nullable=True),
        )
    if "canonical_transcript_rows" not in columns:
        op.add_column(
            "transcripts",
            sa.Column("canonical_transcript_rows", sa.JSON(), nullable=True),
        )
    if "canonical_transcript_version" not in columns:
        op.add_column(
            "transcripts",
            sa.Column("canonical_transcript_version", sa.String(length=64), nullable=True),
        )
    if "canonical_transcript_hash" not in columns:
        op.add_column(
            "transcripts",
            sa.Column("canonical_transcript_hash", sa.String(length=64), nullable=True),
        )
    if "canonical_generated_at" not in columns:
        op.add_column(
            "transcripts",
            sa.Column("canonical_generated_at", sa.DateTime(), nullable=True),
        )
    if "canonical_stats" not in columns:
        op.add_column(
            "transcripts",
            sa.Column("canonical_stats", sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    columns = _existing_columns("transcripts")

    if "canonical_stats" in columns:
        op.drop_column("transcripts", "canonical_stats")
    if "canonical_generated_at" in columns:
        op.drop_column("transcripts", "canonical_generated_at")
    if "canonical_transcript_hash" in columns:
        op.drop_column("transcripts", "canonical_transcript_hash")
    if "canonical_transcript_version" in columns:
        op.drop_column("transcripts", "canonical_transcript_version")
    if "canonical_transcript_rows" in columns:
        op.drop_column("transcripts", "canonical_transcript_rows")
    if "raw_transcript_hash" in columns:
        op.drop_column("transcripts", "raw_transcript_hash")
