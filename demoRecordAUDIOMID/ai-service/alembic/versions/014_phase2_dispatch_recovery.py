"""Phase 2 remediation: dispatch recovery and quota confirmation.

Revision ID: 014
Revises: 013
Create Date: 2026-07-18 14:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def _add_recovery_columns(table: str) -> None:
    op.add_column(table, sa.Column("quota_confirmed_at", sa.DateTime(), nullable=True))
    op.add_column(
        table,
        sa.Column("dispatch_attempt_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(table, sa.Column("last_dispatch_error", sa.Text(), nullable=True))
    op.add_column(table, sa.Column("last_dispatch_error_at", sa.DateTime(), nullable=True))
    op.add_column(table, sa.Column("next_dispatch_retry_at", sa.DateTime(), nullable=True))


def _drop_recovery_columns(table: str) -> None:
    op.drop_column(table, "next_dispatch_retry_at")
    op.drop_column(table, "last_dispatch_error_at")
    op.drop_column(table, "last_dispatch_error")
    op.drop_column(table, "dispatch_attempt_count")
    op.drop_column(table, "quota_confirmed_at")


def upgrade() -> None:
    _add_recovery_columns("subject_synthesis")
    _add_recovery_columns("study_artifact")
    op.create_index(
        "ix_subject_synthesis_quota_confirmed_at",
        "subject_synthesis",
        ["quota_confirmed_at"],
    )
    op.create_index(
        "ix_study_artifact_quota_confirmed_at",
        "study_artifact",
        ["quota_confirmed_at"],
    )
    op.create_index(
        "ix_study_artifact_next_dispatch_retry_at",
        "study_artifact",
        ["next_dispatch_retry_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_study_artifact_next_dispatch_retry_at", table_name="study_artifact")
    op.drop_index("ix_study_artifact_quota_confirmed_at", table_name="study_artifact")
    op.drop_index("ix_subject_synthesis_quota_confirmed_at", table_name="subject_synthesis")
    _drop_recovery_columns("study_artifact")
    _drop_recovery_columns("subject_synthesis")
