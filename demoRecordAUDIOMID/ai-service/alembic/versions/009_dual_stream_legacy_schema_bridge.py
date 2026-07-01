"""Dual-stream legacy schema bridge.

Revision ID: 009
Revises: 008
Create Date: 2026-07-01 00:00:00.000000

"""

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy import text

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None

STREAM_ID_LENGTH = 8
BRIDGE_INDEX = "ix_transcript_fragments_meeting_stream_seq"
STREAM_INDEX = "ix_transcript_fragments_stream_id"
REQUIRED_COLUMNS = {
    "transcripts": ("meeting_id",),
    "analysis": ("meeting_id",),
    "transcript_fragments": ("meeting_id", "seq"),
    "transcript_checkpoints": ("meeting_id",),
}
EXPECTED_INDEXES = {
    STREAM_INDEX: {
        "table": "transcript_fragments",
        "columns": ["stream_id"],
        "unique": False,
    },
    BRIDGE_INDEX: {
        "table": "transcript_fragments",
        "columns": ["meeting_id", "stream_id", "seq"],
        "unique": False,
    },
}


def _require_online() -> None:
    if context.is_offline_mode():
        raise RuntimeError(
            "Revision 009 requires online schema inspection; run without --sql."
        )


def _table_exists(table_name: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return table_name in inspector.get_table_names(schema="public")


def _columns(table_name: str) -> dict[str, dict]:
    inspector = sa.inspect(op.get_bind())
    return {column["name"]: column for column in inspector.get_columns(table_name)}


def _stream_id_shape(table_name: str) -> tuple[str | None, int | None, bool, str | None]:
    row = op.get_bind().execute(
        text(
            """
            SELECT data_type, character_maximum_length, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = :table_name
              AND column_name = 'stream_id'
            """
        ),
        {"table_name": table_name},
    ).mappings().first()
    if row is None:
        return None, None, True, None
    return (
        row["data_type"],
        row["character_maximum_length"],
        row["is_nullable"] == "YES",
        row["column_default"],
    )


def _primary_key(table_name: str) -> tuple[str | None, list[str]]:
    inspector = sa.inspect(op.get_bind())
    pk = inspector.get_pk_constraint(table_name)
    return pk.get("name"), list(pk.get("constrained_columns") or [])


def _find_index(table_name: str, index_name: str) -> dict | None:
    inspector = sa.inspect(op.get_bind())
    return next(
        (index for index in inspector.get_indexes(table_name) if index.get("name") == index_name),
        None,
    )


def _validate_preflight() -> tuple[str | None, list[str]]:
    for table_name, required_columns in REQUIRED_COLUMNS.items():
        if not _table_exists(table_name):
            raise RuntimeError(f"Required table {table_name!r} is missing.")
        existing_columns = _columns(table_name)
        for column_name in required_columns:
            if column_name not in existing_columns:
                raise RuntimeError(
                    f"Required column {table_name}.{column_name} is missing."
                )

    pk_name, pk_columns = _primary_key("transcript_checkpoints")
    if pk_columns not in (["meeting_id"], ["meeting_id", "stream_id"]):
        raise RuntimeError(
            "transcript_checkpoints has unexpected primary key "
            f"{pk_columns!r}; expected ['meeting_id'] or ['meeting_id', 'stream_id']."
        )

    for index_name, expected in EXPECTED_INDEXES.items():
        existing = _find_index(expected["table"], index_name)
        if existing is None:
            continue
        columns = list(existing.get("column_names") or [])
        unique = bool(existing.get("unique"))
        if columns != expected["columns"] or unique != expected["unique"]:
            raise RuntimeError(
                f"{index_name} has unexpected definition columns={columns!r} "
                f"unique={unique!r}; expected columns={expected['columns']!r} "
                f"unique={expected['unique']!r}."
            )

    return pk_name, pk_columns


def _ensure_bigint(table_name: str, column_name: str) -> None:
    if not _table_exists(table_name):
        return
    column = _columns(table_name).get(column_name)
    if column is None:
        return
    if isinstance(column["type"], sa.BigInteger):
        return
    op.execute(
        text(
            f"ALTER TABLE {table_name} "
            f"ALTER COLUMN {column_name} TYPE BIGINT USING {column_name}::bigint"
        )
    )


def _ensure_stream_id_column(table_name: str) -> None:
    if not _table_exists(table_name):
        return

    existing = _columns(table_name)
    if "stream_id" not in existing:
        op.add_column(
            table_name,
            sa.Column(
                "stream_id",
                sa.String(length=STREAM_ID_LENGTH),
                nullable=False,
                server_default=sa.text("''"),
            ),
        )
        return

    data_type, max_length, nullable, default_expr = _stream_id_shape(table_name)
    if data_type not in {"character varying", "text", "character"}:
        raise RuntimeError(
            f"{table_name}.stream_id has unsupported type {data_type!r}; "
            "refusing to alter automatically."
        )
    if max_length is not None and max_length < STREAM_ID_LENGTH:
        raise RuntimeError(
            f"{table_name}.stream_id length {max_length} is narrower than "
            f"required length {STREAM_ID_LENGTH}; refusing to guess."
        )

    if nullable:
        op.execute(text(f"UPDATE {table_name} SET stream_id = '' WHERE stream_id IS NULL"))
        op.alter_column(table_name, "stream_id", nullable=False)

    op.alter_column(table_name, "stream_id", server_default=sa.text("''"))


def _ensure_fragment_indexes() -> None:
    if not _table_exists("transcript_fragments"):
        return
    if _find_index("transcript_fragments", STREAM_INDEX) is None:
        op.create_index(
            STREAM_INDEX,
            "transcript_fragments",
            ["stream_id"],
            unique=False,
        )
    if _find_index("transcript_fragments", BRIDGE_INDEX) is None:
        op.create_index(
            BRIDGE_INDEX,
            "transcript_fragments",
            ["meeting_id", "stream_id", "seq"],
            unique=False,
        )


def _ensure_checkpoint_primary_key(pk_name: str | None, pk_columns: list[str]) -> None:
    if pk_columns == ["meeting_id", "stream_id"]:
        return
    if pk_columns == ["meeting_id"] and pk_name:
        op.drop_constraint(pk_name, "transcript_checkpoints", type_="primary")
        op.create_primary_key(
            "transcript_checkpoints_pkey",
            "transcript_checkpoints",
            ["meeting_id", "stream_id"],
        )
        return
    raise RuntimeError(
        "transcript_checkpoints has unexpected primary key "
        f"{pk_columns!r}; expected ['meeting_id'] or ['meeting_id', 'stream_id']."
    )


def upgrade() -> None:
    _require_online()
    pk_name, pk_columns = _validate_preflight()
    _ensure_bigint("transcripts", "meeting_id")
    _ensure_bigint("analysis", "meeting_id")
    _ensure_stream_id_column("transcript_fragments")
    _ensure_stream_id_column("transcript_checkpoints")
    _ensure_checkpoint_primary_key(pk_name, pk_columns)
    _ensure_fragment_indexes()


def downgrade() -> None:
    _require_online()
    # Data-preserving no-op: Revision 009 may have adopted pre-existing stream
    # columns, checkpoint constraints, or indexes, so downgrade must not remove
    # objects that this revision cannot prove it owns.
    pass
