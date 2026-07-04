"""Add transcript attempt provenance.

Revision ID: 010
Revises: 009
Create Date: 2026-07-01 00:00:00.000000

"""

from alembic import context, op
import sqlalchemy as sa

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None

ATTEMPT_CHECKPOINT_TABLE = "transcript_attempt_checkpoints"
V2_FRAGMENT_INDEX = "ix_transcript_fragments_v2_event_identity"
ATTEMPT_LOOKUP_INDEX = "ix_transcript_attempt_checkpoints_meeting_session_stream"

STREAM_ID_MIN_LENGTH = 8

V2_FRAGMENT_INDEX_COLUMNS = [
    "meeting_id",
    "recording_session_id",
    "attempt_id",
    "stream_id",
    "seq",
]
ATTEMPT_LOOKUP_INDEX_COLUMNS = [
    "meeting_id",
    "recording_session_id",
    "stream_id",
]


def _require_online() -> None:
    if context.is_offline_mode():
        raise RuntimeError(
            "Revision 010 requires online schema inspection; run without --sql."
        )


def _bind():
    return op.get_bind()


def _inspector():
    return sa.inspect(_bind())


def _table_exists(table_name: str) -> bool:
    return table_name in _inspector().get_table_names(schema="public")


def _column_shapes(table_name: str) -> dict[str, dict]:
    rows = (
        _bind()
        .execute(
            sa.text("""
            SELECT column_name,
                   data_type,
                   character_maximum_length,
                   is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = :table_name
            """),
            {"table_name": table_name},
        )
        .mappings()
        .all()
    )
    return {row["column_name"]: dict(row) for row in rows}


def _primary_key(table_name: str) -> tuple[str | None, list[str]]:
    primary_key = _inspector().get_pk_constraint(table_name)
    return (
        primary_key.get("name"),
        list(primary_key.get("constrained_columns") or []),
    )


def _find_index(table_name: str, index_name: str) -> dict | None:
    return next(
        (
            index
            for index in _inspector().get_indexes(table_name)
            if index.get("name") == index_name
        ),
        None,
    )


def _require_shape(
    table_name: str,
    column_name: str,
    *,
    data_type: str,
    max_length: int | None,
    nullable: bool,
) -> dict:
    shape = _column_shapes(table_name).get(column_name)
    if shape is None:
        raise RuntimeError(f"Required column {table_name}.{column_name} is missing.")

    actual_nullable = shape["is_nullable"] == "YES"
    if (
        shape["data_type"] != data_type
        or shape["character_maximum_length"] != max_length
        or actual_nullable != nullable
    ):
        raise RuntimeError(
            f"{table_name}.{column_name} has incompatible shape "
            f"data_type={shape['data_type']!r}, "
            f"max_length={shape['character_maximum_length']!r}, "
            f"nullable={actual_nullable!r}; expected "
            f"data_type={data_type!r}, max_length={max_length!r}, "
            f"nullable={nullable!r}."
        )
    return shape


def _require_fragment_stream_shape() -> dict:
    shape = _column_shapes("transcript_fragments").get("stream_id")
    if shape is None:
        raise RuntimeError("Required column transcript_fragments.stream_id is missing.")

    actual_nullable = shape["is_nullable"] == "YES"
    data_type = shape["data_type"]
    max_length = shape["character_maximum_length"]

    if actual_nullable:
        raise RuntimeError(
            "transcript_fragments.stream_id must be NOT NULL before Revision 010."
        )
    if data_type not in {"character varying", "text", "character"}:
        raise RuntimeError(
            "transcript_fragments.stream_id has unsupported type "
            f"{data_type!r}; refusing to create an incompatible v2 table."
        )
    if max_length is not None and max_length < STREAM_ID_MIN_LENGTH:
        raise RuntimeError(
            "transcript_fragments.stream_id length "
            f"{max_length} is narrower than required minimum "
            f"{STREAM_ID_MIN_LENGTH}."
        )
    return shape


def _stream_sqlalchemy_type(shape: dict) -> sa.types.TypeEngine:
    data_type = shape["data_type"]
    max_length = shape["character_maximum_length"]

    if data_type == "character varying":
        return sa.String(length=max_length)
    if data_type == "text":
        return sa.Text()
    if data_type == "character" and max_length is not None:
        return sa.CHAR(length=max_length)

    raise RuntimeError(
        "Unsupported transcript_fragments.stream_id shape for v2 checkpoint "
        f"table: data_type={data_type!r}, max_length={max_length!r}."
    )


def _require_matching_stream_shape(
    table_name: str,
    column_name: str,
    expected_shape: dict,
    *,
    nullable: bool,
) -> None:
    actual_shape = _column_shapes(table_name).get(column_name)
    if actual_shape is None:
        raise RuntimeError(f"Required column {table_name}.{column_name} is missing.")

    actual_nullable = actual_shape["is_nullable"] == "YES"
    if (
        actual_shape["data_type"] != expected_shape["data_type"]
        or actual_shape["character_maximum_length"]
        != expected_shape["character_maximum_length"]
        or actual_nullable != nullable
    ):
        raise RuntimeError(
            f"{table_name}.{column_name} is incompatible with "
            "transcript_fragments.stream_id; expected the same type and "
            f"length with nullable={nullable!r}."
        )


def _validate_index_if_present(
    table_name: str,
    index_name: str,
    expected_columns: list[str],
) -> None:
    existing = _find_index(table_name, index_name)
    if existing is None:
        return

    actual_columns = list(existing.get("column_names") or [])
    actual_unique = bool(existing.get("unique"))
    if actual_columns != expected_columns or actual_unique:
        raise RuntimeError(
            f"{index_name} has incompatible definition "
            f"columns={actual_columns!r}, unique={actual_unique!r}; expected "
            f"non-unique columns={expected_columns!r}."
        )


def _validate_fragment_preflight() -> dict:
    if not _table_exists("transcript_fragments"):
        raise RuntimeError("Required table 'transcript_fragments' is missing.")

    _require_shape(
        "transcript_fragments",
        "meeting_id",
        data_type="bigint",
        max_length=None,
        nullable=False,
    )
    _require_shape(
        "transcript_fragments",
        "seq",
        data_type="integer",
        max_length=None,
        nullable=False,
    )
    stream_shape = _require_fragment_stream_shape()

    fragment_columns = _column_shapes("transcript_fragments")
    for provenance_column in ("recording_session_id", "attempt_id"):
        if provenance_column in fragment_columns:
            _require_shape(
                "transcript_fragments",
                provenance_column,
                data_type="bigint",
                max_length=None,
                nullable=True,
            )

    _validate_index_if_present(
        "transcript_fragments",
        V2_FRAGMENT_INDEX,
        V2_FRAGMENT_INDEX_COLUMNS,
    )
    return stream_shape


def _validate_existing_attempt_checkpoint_table(stream_shape: dict) -> None:
    if not _table_exists(ATTEMPT_CHECKPOINT_TABLE):
        return

    _require_shape(
        ATTEMPT_CHECKPOINT_TABLE,
        "meeting_id",
        data_type="bigint",
        max_length=None,
        nullable=False,
    )
    _require_shape(
        ATTEMPT_CHECKPOINT_TABLE,
        "recording_session_id",
        data_type="bigint",
        max_length=None,
        nullable=False,
    )
    _require_shape(
        ATTEMPT_CHECKPOINT_TABLE,
        "attempt_id",
        data_type="bigint",
        max_length=None,
        nullable=False,
    )
    _require_matching_stream_shape(
        ATTEMPT_CHECKPOINT_TABLE,
        "stream_id",
        stream_shape,
        nullable=False,
    )
    for checkpoint_column in (
        "last_ack_seq",
        "last_persisted_seq",
        "last_finalized_seq",
    ):
        _require_shape(
            ATTEMPT_CHECKPOINT_TABLE,
            checkpoint_column,
            data_type="integer",
            max_length=None,
            nullable=False,
        )
    _require_shape(
        ATTEMPT_CHECKPOINT_TABLE,
        "updated_at",
        data_type="timestamp without time zone",
        max_length=None,
        nullable=False,
    )

    _, primary_key_columns = _primary_key(ATTEMPT_CHECKPOINT_TABLE)
    expected_primary_key = [
        "meeting_id",
        "recording_session_id",
        "attempt_id",
        "stream_id",
    ]
    if primary_key_columns != expected_primary_key:
        raise RuntimeError(
            f"{ATTEMPT_CHECKPOINT_TABLE} has incompatible primary key "
            f"{primary_key_columns!r}; expected {expected_primary_key!r}."
        )

    _validate_index_if_present(
        ATTEMPT_CHECKPOINT_TABLE,
        ATTEMPT_LOOKUP_INDEX,
        ATTEMPT_LOOKUP_INDEX_COLUMNS,
    )


def _validate_preflight() -> dict:
    stream_shape = _validate_fragment_preflight()
    _validate_existing_attempt_checkpoint_table(stream_shape)
    return stream_shape


def _add_fragment_provenance_columns() -> None:
    fragment_columns = _column_shapes("transcript_fragments")
    if "recording_session_id" not in fragment_columns:
        op.add_column(
            "transcript_fragments",
            sa.Column(
                "recording_session_id",
                sa.BigInteger(),
                nullable=True,
            ),
        )
    if "attempt_id" not in fragment_columns:
        op.add_column(
            "transcript_fragments",
            sa.Column(
                "attempt_id",
                sa.BigInteger(),
                nullable=True,
            ),
        )


def _create_attempt_checkpoint_table(stream_shape: dict) -> None:
    if _table_exists(ATTEMPT_CHECKPOINT_TABLE):
        return

    op.create_table(
        ATTEMPT_CHECKPOINT_TABLE,
        sa.Column("meeting_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "recording_session_id",
            sa.BigInteger(),
            nullable=False,
        ),
        sa.Column(
            "attempt_id",
            sa.BigInteger(),
            nullable=False,
        ),
        sa.Column("stream_id", _stream_sqlalchemy_type(stream_shape), nullable=False),
        sa.Column(
            "last_ack_seq",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "last_persisted_seq",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "last_finalized_seq",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint(
            "meeting_id",
            "recording_session_id",
            "attempt_id",
            "stream_id",
            name="transcript_attempt_checkpoints_pkey",
        ),
    )


def _ensure_index(
    table_name: str,
    index_name: str,
    columns: list[str],
) -> None:
    if _find_index(table_name, index_name) is None:
        op.create_index(index_name, table_name, columns, unique=False)


def upgrade() -> None:
    _require_online()
    stream_shape = _validate_preflight()
    _add_fragment_provenance_columns()
    _create_attempt_checkpoint_table(stream_shape)
    _ensure_index(
        "transcript_fragments",
        V2_FRAGMENT_INDEX,
        V2_FRAGMENT_INDEX_COLUMNS,
    )
    _ensure_index(
        ATTEMPT_CHECKPOINT_TABLE,
        ATTEMPT_LOOKUP_INDEX,
        ATTEMPT_LOOKUP_INDEX_COLUMNS,
    )


def downgrade() -> None:
    _require_online()
    # Data-preserving no-op: Revision 010 may adopt compatible pre-existing
    # provenance columns, indexes, or v2 checkpoint objects. Removing them
    # would destroy v2 provenance/checkpoint data and may delete objects this
    # revision cannot prove it owns.
    pass
