"""Phase 2 remediation: dispatch idempotency columns and synthesis options_json.

Revision ID: 013
Revises: 012
Create Date: 2026-07-18 12:00:00.000000

"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def _add_dispatch_columns(table: str) -> None:
    op.add_column(
        table, sa.Column("dispatch_requested_at", sa.DateTime(), nullable=True)
    )
    op.add_column(table, sa.Column("celery_task_id", sa.String(128), nullable=True))
    op.add_column(
        table, sa.Column("processing_started_at", sa.DateTime(), nullable=True)
    )
    op.add_column(
        table,
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(table, sa.Column("last_heartbeat_at", sa.DateTime(), nullable=True))


def _drop_dispatch_columns(table: str) -> None:
    op.drop_column(table, "last_heartbeat_at")
    op.drop_column(table, "attempt_count")
    op.drop_column(table, "processing_started_at")
    op.drop_column(table, "celery_task_id")
    op.drop_column(table, "dispatch_requested_at")


def upgrade() -> None:
    op.add_column(
        "subject_synthesis",
        sa.Column("options_json", JSONB(), nullable=True),
    )
    _add_dispatch_columns("subject_synthesis")
    _add_dispatch_columns("study_artifact")
    op.create_index(
        "ix_subject_synthesis_dispatch_requested_at",
        "subject_synthesis",
        ["dispatch_requested_at"],
    )
    op.create_index(
        "ix_study_artifact_dispatch_requested_at",
        "study_artifact",
        ["dispatch_requested_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_study_artifact_dispatch_requested_at", table_name="study_artifact"
    )
    op.drop_index(
        "ix_subject_synthesis_dispatch_requested_at", table_name="subject_synthesis"
    )
    _drop_dispatch_columns("study_artifact")
    _drop_dispatch_columns("subject_synthesis")
    op.drop_column("subject_synthesis", "options_json")
