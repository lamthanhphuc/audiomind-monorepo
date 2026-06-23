"""Add canonical_transcript_rows + evidence_stats to meeting_analysis_runs (Epic 3 §9.1)."""

from alembic import op
import sqlalchemy as sa

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def _existing_columns(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {col["name"] for col in inspector.get_columns(table_name)}


def upgrade() -> None:
    columns = _existing_columns("meeting_analysis_runs")
    if "canonical_transcript_rows" not in columns:
        op.add_column(
            "meeting_analysis_runs",
            sa.Column("canonical_transcript_rows", sa.JSON(), nullable=True),
        )
    if "evidence_stats" not in columns:
        op.add_column(
            "meeting_analysis_runs",
            sa.Column("evidence_stats", sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    columns = _existing_columns("meeting_analysis_runs")
    if "evidence_stats" in columns:
        op.drop_column("meeting_analysis_runs", "evidence_stats")
    if "canonical_transcript_rows" in columns:
        op.drop_column("meeting_analysis_runs", "canonical_transcript_rows")
