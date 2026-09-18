"""
Creates all tables registered on `Base.metadata`, then applies any
additive column changes the ORM models have picked up since the
database file was first created.

Import every model module here before calling `init_db()` so SQLAlchemy
knows about its table — `database.models` (imported below purely for
that side effect: it defines `Document(Base)` and
`FieldCorrection(Base)`, which register the `documents` and
`field_corrections` tables on `Base.metadata` on import) is that import.
`create_all` only creates tables that don't already exist, so this is
safe to call on every app startup, not just the first one.

`create_all` does *not* alter an existing table's columns, though, which
is why `_add_missing_columns` below exists: the review workflow added
three columns to `documents`, and this project's existing SQLite file
already holds real processed documents. Rather than require that file to
be deleted and re-created (losing them), each new column is added in
place with `ALTER TABLE ... ADD COLUMN` if it isn't there yet.

This is intentionally the narrowest possible migration mechanism —
additive columns only, no ordering, no down-migrations, no history — and
it is not a substitute for Alembic once this project has deployments to
keep in sync. It exists so that a schema change doesn't silently break a
running local install with data in it.
"""
import logging

from sqlalchemy import inspect, text

from database import models  # noqa: F401 (imported for its side effect: registers the ORM tables on Base.metadata)
from database.base import Base
from database.session import engine

logger = logging.getLogger(__name__)


def _add_missing_columns() -> None:
    """Add any mapped column that's missing from an already-created table."""
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())

    with engine.begin() as connection:
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue  # create_all just made it, so it's already current.

            present = {column["name"] for column in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in present:
                    continue

                ddl = f"ALTER TABLE {table.name} ADD COLUMN {column.name} {column.type.compile(engine.dialect)}"

                # A NOT NULL column can only be added to a table that
                # may already hold rows if there's a constant default to
                # backfill them with — which every column added this way
                # so far has (e.g. review_status defaults to "Pending
                # Review", the correct state for a document nobody has
                # reviewed yet). SQLite additionally rejects a
                # non-constant default (CURRENT_TIMESTAMP and friends)
                # in ADD COLUMN at all, so anything other than a literal
                # is refused here with a clear message rather than a
                # confusing OperationalError mid-startup.
                default = column.server_default
                if default is not None:
                    if not isinstance(default.arg, str):
                        raise RuntimeError(
                            f"Cannot add {table.name}.{column.name} in place: its server default is not a "
                            "literal value. This change needs a real migration."
                        )
                    escaped = default.arg.replace("'", "''")
                    ddl += f" DEFAULT '{escaped}'"
                    if not column.nullable:
                        ddl += " NOT NULL"
                elif not column.nullable:
                    raise RuntimeError(
                        f"Cannot add NOT NULL column {table.name}.{column.name} without a server default; "
                        "this change needs a real migration."
                    )

                logger.info("Adding missing column %s.%s", table.name, column.name)
                connection.execute(text(ddl))


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _add_missing_columns()
