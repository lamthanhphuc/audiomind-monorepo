"""Add retry metadata columns to meeting_analysis_runs

Revision ID: 007
Revises: 006
Create Date: 2026-06-16 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def _column_names(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {column["name"] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    existing = _column_names("meeting_analysis_runs")
    if "analysis_retry_count" not in existing:
        op.add_column(
            "meeting_analysis_runs",
            sa.Column("analysis_retry_count", sa.Integer(), nullable=False, server_default="0"),
        )
    if "analysis_next_retry_at" not in existing:
        op.add_column(
            "meeting_analysis_runs",
            sa.Column("analysis_next_retry_at", sa.DateTime(), nullable=True),
        )
    if "analysis_last_attempt_at" not in existing:
        op.add_column(
            "meeting_analysis_runs",
            sa.Column("analysis_last_attempt_at", sa.DateTime(), nullable=True),
        )
    if "analysis_provider_alias" not in existing:
        op.add_column(
            "meeting_analysis_runs",
            sa.Column("analysis_provider_alias", sa.String(length=32), nullable=True),
        )
    if "analysis_trace_id" not in existing:
        op.add_column(
            "meeting_analysis_runs",
            sa.Column("analysis_trace_id", sa.String(length=64), nullable=True),
        )
    if "analysis_input_hash" not in existing:
        op.add_column(
            "meeting_analysis_runs",
            sa.Column("analysis_input_hash", sa.String(length=64), nullable=True),
        )


def downgrade() -> None:
    existing = _column_names("meeting_analysis_runs")
    for column_name in (
        "analysis_input_hash",
        "analysis_trace_id",
        "analysis_provider_alias",
        "analysis_last_attempt_at",
        "analysis_next_retry_at",
        "analysis_retry_count",
    ):
        if column_name in existing:
            op.drop_column("meeting_analysis_runs", column_name)
