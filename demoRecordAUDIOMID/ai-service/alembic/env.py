"""
Alembic configuration
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

# Import your models
from app.config import get_settings
from app.database import Base

# this is the Alembic Config object
config = context.config

# Interpret the config file for Python logging.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

settings = get_settings()
# ConfigParser treats % as interpolation; URL-encoded passwords must be escaped.
_database_url = settings.database_url
config.set_main_option("sqlalchemy.url", _database_url.replace("%", "%%"))

# add your model's MetaData object here
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    context.configure(
        url=_database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    # Prefer create_engine with the raw URL so ConfigParser cannot mangle %.
    connectable = create_engine(_database_url, poolclass=pool.NullPool)

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
