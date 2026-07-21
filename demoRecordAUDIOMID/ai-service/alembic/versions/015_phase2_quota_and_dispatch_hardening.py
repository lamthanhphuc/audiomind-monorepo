"""Phase 2 third remediation: membership hash for source guards.

Revision ID: 015
Revises: 014
Create Date: 2026-07-18 16:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "subject_synthesis",
        sa.Column("subject_membership_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "study_artifact",
        sa.Column("subject_membership_hash", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("study_artifact", "subject_membership_hash")
    op.drop_column("subject_synthesis", "subject_membership_hash")
