"""Create realtime STT fragment and checkpoint tables

Revision ID: 004
Revises: 003
Create Date: 2026-05-16 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "transcript_fragments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("meeting_id", sa.BigInteger(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("event_id", sa.String(length=64), nullable=True),
        sa.Column("speaker", sa.String(length=50), nullable=True),
        sa.Column("start_time", sa.Float(), nullable=True),
        sa.Column("end_time", sa.Float(), nullable=True),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column("normalized_text", sa.String(length=2048), nullable=False),
        sa.Column("is_final", sa.Boolean(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("dedupe_key", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "dedupe_key",
            name="uq_transcript_fragments_dedupe_key",
        ),
    )
    op.create_index(
        op.f("ix_transcript_fragments_id"),
        "transcript_fragments",
        ["id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_transcript_fragments_meeting_id"),
        "transcript_fragments",
        ["meeting_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_transcript_fragments_seq"),
        "transcript_fragments",
        ["seq"],
        unique=False,
    )
    op.create_index(
        op.f("ix_transcript_fragments_event_id"),
        "transcript_fragments",
        ["event_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_transcript_fragments_dedupe_key"),
        "transcript_fragments",
        ["dedupe_key"],
        unique=False,
    )

    op.create_table(
        "transcript_checkpoints",
        sa.Column("meeting_id", sa.BigInteger(), nullable=False),
        sa.Column("last_ack_seq", sa.Integer(), nullable=False),
        sa.Column("last_persisted_seq", sa.Integer(), nullable=False),
        sa.Column("last_finalized_seq", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("meeting_id"),
    )
    op.create_index(
        op.f("ix_transcript_checkpoints_meeting_id"),
        "transcript_checkpoints",
        ["meeting_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_transcript_checkpoints_meeting_id"),
        table_name="transcript_checkpoints",
    )
    op.drop_table("transcript_checkpoints")
    op.drop_index(
        op.f("ix_transcript_fragments_dedupe_key"),
        table_name="transcript_fragments",
    )
    op.drop_index(
        op.f("ix_transcript_fragments_event_id"),
        table_name="transcript_fragments",
    )
    op.drop_index(
        op.f("ix_transcript_fragments_seq"),
        table_name="transcript_fragments",
    )
    op.drop_index(
        op.f("ix_transcript_fragments_meeting_id"),
        table_name="transcript_fragments",
    )
    op.drop_index(
        op.f("ix_transcript_fragments_id"),
        table_name="transcript_fragments",
    )
    op.drop_table("transcript_fragments")
