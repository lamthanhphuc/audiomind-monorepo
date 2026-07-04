"""Add recording attempt provenance to meeting_analysis_runs.

Revision ID: 011
Revises: 010
Create Date: 2026-07-03 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def _existing_columns(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {col["name"] for col in inspector.get_columns(table_name)}


def upgrade() -> None:
    columns = _existing_columns("meeting_analysis_runs")
    if "recording_session_id" not in columns:
        op.add_column(
            "meeting_analysis_runs",
            sa.Column("recording_session_id", sa.BigInteger(), nullable=True),
        )
    if "attempt_id" not in columns:
        op.add_column(
            "meeting_analysis_runs",
            sa.Column("attempt_id", sa.BigInteger(), nullable=True),
        )
    op.create_index(
        "ix_meeting_analysis_runs_scope_lookup",
        "meeting_analysis_runs",
        ["meeting_id", "recording_session_id", "attempt_id", "status"],
        unique=False,
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_meeting_analysis_runs_scope_lookup",
        table_name="meeting_analysis_runs",
        if_exists=True,
    )
    columns = _existing_columns("meeting_analysis_runs")
    if "attempt_id" in columns:
        op.drop_column("meeting_analysis_runs", "attempt_id")
    if "recording_session_id" in columns:
        op.drop_column("meeting_analysis_runs", "recording_session_id")
