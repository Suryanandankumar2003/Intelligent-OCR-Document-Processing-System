"""
Database engine, session factory, and FastAPI dependency.

Everything below is SQLite-specific in the ways called out inline.
Swapping to a networked database (Postgres/MySQL) later means revisiting
`connect_args` and the pragma listener below — nothing else in the app
(models, CRUD, routes) would need to change, since they only ever
interact with a plain SQLAlchemy `Session`.
"""
import logging
from typing import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

engine = create_engine(
    settings.DATABASE_URL,
    # SQLite opens one connection per thread by default and refuses to
    # hand that connection to a different thread. FastAPI's sync
    # dependencies (get_db below) can run on a different worker thread
    # per request, so this is required, not optional, for a SQLite-backed
    # app — without it, the second request handled on a new thread
    # raises "SQLite objects created in a thread can only be used in
    # that same thread".
    connect_args={"check_same_thread": False},
    # Tests each pooled connection with a lightweight ping before
    # handing it out. Close to a no-op for a local SQLite file, but
    # keeps this engine config forward-compatible with a future
    # networked database, where stale/dropped connections are a real
    # failure mode this setting avoids surfacing as a request error.
    pool_pre_ping=True,
    # Logs every SQL statement when DEBUG=true (local development) and
    # stays silent otherwise — a free debugging aid with no separate
    # flag to remember to turn off before deploying.
    echo=settings.DEBUG,
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, connection_record) -> None:
    """
    Apply per-connection SQLite settings a production deployment wants.
    Runs once per new physical connection (SQLAlchemy fires the
    `connect` event automatically), not once per request.

    * `foreign_keys=ON` — SQLite silently ignores FOREIGN KEY
      constraints unless this is turned on for the connection; without
      it, a bad reference wouldn't be rejected, it would just be stored.
      Not load-bearing yet (there is only one table), but free insurance
      for the next table that references `documents`.
    * `journal_mode=WAL` — lets readers proceed while a write is in
      progress, instead of SQLite's default behavior where a writer
      blocks every reader (and vice versa) for the duration of the
      transaction. FastAPI can have multiple requests hitting the
      database concurrently, so this materially reduces "database is
      locked" errors under load. Has no effect (and no downside) on an
      in-memory database, e.g. in tests that override DATABASE_URL.
    """
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session, None, None]:
    """
    FastAPI dependency that yields a DB session scoped to one request.

    Rolls back on any exception raised while the session is in use — so
    a request that fails partway through never leaves a half-applied
    change sitting uncommitted in the session, which could otherwise be
    accidentally flushed by an unrelated later `db.commit()` sharing the
    same session object. Always closes the session/connection
    afterwards, on both the success and failure paths.
    """
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
