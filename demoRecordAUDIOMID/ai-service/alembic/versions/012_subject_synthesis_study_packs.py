"""Phase 2: subject_synthesis and study_artifact tables.

Revision ID: 012
Revises: 011
Create Date: 2026-07-18 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "subject_synthesis",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("subject_id", sa.BigInteger(), nullable=False),
        sa.Column("owner_user_id", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("title", sa.String(255), nullable=True),
        sa.Column("content_json", JSONB(), nullable=True),
        sa.Column("source_hash", sa.String(64), nullable=False),
        sa.Column("options_hash", sa.String(64), nullable=True),
        sa.Column("source_selection_mode", sa.String(20), nullable=False, server_default="ALL_READY"),
        sa.Column("prompt_version", sa.String(100), nullable=True),
        sa.Column("schema_version", sa.String(100), nullable=True),
        sa.Column("idempotency_key", sa.String(256), nullable=False),
        sa.Column("generation_request_id", sa.String(64), nullable=True),
        sa.Column("error_code", sa.String(100), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("warnings_json", JSONB(), nullable=True),
        sa.Column("generated_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "idx_subject_synthesis_owner_subject",
        "subject_synthesis",
        ["owner_user_id", "subject_id"],
    )
    op.create_index("idx_subject_synthesis_status", "subject_synthesis", ["status"])
    op.execute(
        """
        CREATE UNIQUE INDEX uq_subject_synthesis_idempotency_live
        ON subject_synthesis(idempotency_key)
        WHERE deleted_at IS NULL
        """
    )

    op.create_table(
        "subject_synthesis_source",
        sa.Column("synthesis_id", sa.BigInteger(), nullable=False),
        sa.Column("meeting_id", sa.BigInteger(), nullable=False),
        sa.Column("transcript_hash", sa.String(64), nullable=True),
        sa.Column("analysis_run_id", sa.BigInteger(), nullable=True),
        sa.Column("analysis_version", sa.String(100), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("synthesis_id", "meeting_id"),
        sa.ForeignKeyConstraint(["synthesis_id"], ["subject_synthesis.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "idx_subject_synthesis_source_meeting",
        "subject_synthesis_source",
        ["meeting_id"],
    )

    op.create_table(
        "study_artifact",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("owner_user_id", sa.BigInteger(), nullable=False),
        sa.Column("subject_id", sa.BigInteger(), nullable=False),
        sa.Column("synthesis_id", sa.BigInteger(), nullable=True),
        sa.Column("artifact_type", sa.String(40), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("title", sa.String(255), nullable=True),
        sa.Column("options_json", JSONB(), nullable=True),
        sa.Column("content_json", JSONB(), nullable=True),
        sa.Column("source_hash", sa.String(64), nullable=False),
        sa.Column("options_hash", sa.String(64), nullable=False),
        sa.Column("source_selection_mode", sa.String(20), nullable=False, server_default="ALL_READY"),
        sa.Column("prompt_version", sa.String(100), nullable=True),
        sa.Column("schema_version", sa.String(100), nullable=True),
        sa.Column("idempotency_key", sa.String(256), nullable=False),
        sa.Column("generation_request_id", sa.String(64), nullable=True),
        sa.Column("error_code", sa.String(100), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("warnings_json", JSONB(), nullable=True),
        sa.Column("generated_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "idx_study_artifact_owner_subject",
        "study_artifact",
        ["owner_user_id", "subject_id"],
    )
    op.create_index("idx_study_artifact_type", "study_artifact", ["artifact_type"])
    op.create_index("idx_study_artifact_status", "study_artifact", ["status"])
    op.execute(
        """
        CREATE UNIQUE INDEX uq_study_artifact_idempotency_live
        ON study_artifact(idempotency_key)
        WHERE deleted_at IS NULL
        """
    )

    op.create_table(
        "study_artifact_source",
        sa.Column("artifact_id", sa.BigInteger(), nullable=False),
        sa.Column("meeting_id", sa.BigInteger(), nullable=False),
        sa.Column("transcript_hash", sa.String(64), nullable=True),
        sa.Column("analysis_run_id", sa.BigInteger(), nullable=True),
        sa.Column("analysis_version", sa.String(100), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("artifact_id", "meeting_id"),
        sa.ForeignKeyConstraint(["artifact_id"], ["study_artifact.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "idx_study_artifact_source_meeting",
        "study_artifact_source",
        ["meeting_id"],
    )


def downgrade() -> None:
    op.drop_table("study_artifact_source")
    op.execute("DROP INDEX IF EXISTS uq_study_artifact_idempotency_live")
    op.drop_table("study_artifact")
    op.drop_table("subject_synthesis_source")
    op.execute("DROP INDEX IF EXISTS uq_subject_synthesis_idempotency_live")
    op.drop_table("subject_synthesis")
