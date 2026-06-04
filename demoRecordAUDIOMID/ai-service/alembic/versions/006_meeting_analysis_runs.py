"""Add versioned meeting analysis runs

Revision ID: 006
Revises: 005
Create Date: 2026-06-03 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def _existing_tables() -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return set(inspector.get_table_names())


def upgrade() -> None:
    if "meeting_analysis_runs" in _existing_tables():
        return

    op.create_table(
        "meeting_analysis_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("meeting_id", sa.BigInteger(), nullable=False),
        sa.Column("owner_id", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("prompt_version", sa.String(length=64), nullable=False),
        sa.Column("schema_version", sa.String(length=64), nullable=False),
        sa.Column("canonical_transcript_hash", sa.String(length=64), nullable=True),
        sa.Column("canonical_transcript_version", sa.String(length=64), nullable=True),
        sa.Column("speaker_stabilization_version", sa.String(length=64), nullable=True),
        sa.Column("recognition_mode", sa.String(length=64), nullable=True),
        sa.Column("transcript_language", sa.String(length=16), nullable=True),
        sa.Column("analysis_input_mode", sa.String(length=64), nullable=False),
        sa.Column("analysis_payload_json", sa.JSON(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("idempotency_key", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("requested_by", sa.String(length=128), nullable=True),
        sa.Column("rerun_reason", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "idempotency_key", name="uq_meeting_analysis_runs_idempotency_key"
        ),
    )
    op.create_index(
        op.f("ix_meeting_analysis_runs_id"),
        "meeting_analysis_runs",
        ["id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_meeting_analysis_runs_meeting_id"),
        "meeting_analysis_runs",
        ["meeting_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_meeting_analysis_runs_owner_id"),
        "meeting_analysis_runs",
        ["owner_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_meeting_analysis_runs_status"),
        "meeting_analysis_runs",
        ["status"],
        unique=False,
    )
    op.create_index(
        op.f("ix_meeting_analysis_runs_canonical_transcript_hash"),
        "meeting_analysis_runs",
        ["canonical_transcript_hash"],
        unique=False,
    )
    op.create_index(
        "ix_meeting_analysis_runs_meeting_status_updated",
        "meeting_analysis_runs",
        ["meeting_id", "status", "updated_at"],
        unique=False,
    )
    op.create_index(
        "ix_meeting_analysis_runs_cache_lookup",
        "meeting_analysis_runs",
        [
            "meeting_id",
            "canonical_transcript_hash",
            "prompt_version",
            "schema_version",
            "provider",
            "model",
        ],
        unique=False,
    )


def downgrade() -> None:
    if "meeting_analysis_runs" not in _existing_tables():
        return

    op.drop_index(
        "ix_meeting_analysis_runs_cache_lookup",
        table_name="meeting_analysis_runs",
    )
    op.drop_index(
        "ix_meeting_analysis_runs_meeting_status_updated",
        table_name="meeting_analysis_runs",
    )
    op.drop_index(
        op.f("ix_meeting_analysis_runs_canonical_transcript_hash"),
        table_name="meeting_analysis_runs",
    )
    op.drop_index(
        op.f("ix_meeting_analysis_runs_status"),
        table_name="meeting_analysis_runs",
    )
    op.drop_index(
        op.f("ix_meeting_analysis_runs_owner_id"),
        table_name="meeting_analysis_runs",
    )
    op.drop_index(
        op.f("ix_meeting_analysis_runs_meeting_id"),
        table_name="meeting_analysis_runs",
    )
    op.drop_index(
        op.f("ix_meeting_analysis_runs_id"), table_name="meeting_analysis_runs"
    )
    op.drop_table("meeting_analysis_runs")
