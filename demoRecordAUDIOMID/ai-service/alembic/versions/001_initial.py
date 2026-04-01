"""Initial migration - create transcripts and analysis tables

Revision ID: 001
Revises: 
Create Date: 2024-01-01 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create transcripts table
    op.create_table(
        'transcripts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('meeting_id', sa.Integer(), nullable=False),
        sa.Column('speaker', sa.String(length=50), nullable=True),
        sa.Column('start_time', sa.Float(), nullable=True),
        sa.Column('end_time', sa.Float(), nullable=True),
        sa.Column('text', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_transcripts_id'), 'transcripts', ['id'], unique=False)
    op.create_index(op.f('ix_transcripts_meeting_id'), 'transcripts', ['meeting_id'], unique=False)

    # Create analysis table
    op.create_table(
        'analysis',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('meeting_id', sa.Integer(), nullable=False),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('keywords', postgresql.JSON(astext_type=sa.Text()), nullable=True),
        sa.Column('technical_terms', postgresql.JSON(astext_type=sa.Text()), nullable=True),
        sa.Column('action_items', postgresql.JSON(astext_type=sa.Text()), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('transcript_id', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['transcript_id'], ['transcripts.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('meeting_id')
    )
    op.create_index(op.f('ix_analysis_id'), 'analysis', ['id'], unique=False)
    op.create_index(op.f('ix_analysis_meeting_id'), 'analysis', ['meeting_id'], unique=True)


def downgrade() -> None:
    op.drop_index(op.f('ix_analysis_meeting_id'), table_name='analysis')
    op.drop_index(op.f('ix_analysis_id'), table_name='analysis')
    op.drop_table('analysis')
    op.drop_index(op.f('ix_transcripts_meeting_id'), table_name='transcripts')
    op.drop_index(op.f('ix_transcripts_id'), table_name='transcripts')
    op.drop_table('transcripts')
