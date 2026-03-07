from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect
from sqlalchemy.engine import URL, make_url

from .config import Settings
from .db import create_engine_and_session
from .seeds import seed_preset_data
from .utils.encryption import SettingsCipher

LEGACY_BASELINE_REVISION = "0001_initial"
LEGACY_SCHEMA_TABLES = {
    "ingest_batches",
    "dim_users",
    "dim_projects",
    "app_settings",
    "ai_code_events",
    "fact_ai_code_daily",
}


def initialize_application_database(settings: Settings) -> None:
    ensure_database_exists(settings.database_url)
    run_database_migrations(settings.database_url)
    seed_database(settings)


def ensure_database_exists(database_url: str) -> None:
    url = make_url(database_url)

    if url.drivername.startswith("sqlite"):
        _ensure_sqlite_parent_directory(url)
        return

    if not url.drivername.startswith("mysql"):
        return

    if not url.database:
        raise ValueError("MySQL DATABASE_URL must include a database name.")

    admin_engine = create_engine(
        _build_mysql_admin_url(url),
        future=True,
        pool_pre_ping=True,
        isolation_level="AUTOCOMMIT",
    )
    try:
        with admin_engine.connect() as connection:
            connection.exec_driver_sql(_build_create_database_sql(url))
    finally:
        admin_engine.dispose()


def run_database_migrations(database_url: str) -> None:
    config = _build_alembic_config(database_url)
    _stamp_legacy_schema_if_needed(database_url, config)
    command.upgrade(config, "head")


def seed_database(settings: Settings) -> None:
    engine, session_local = create_engine_and_session(settings.database_url)
    try:
        db = session_local()
        try:
            seed_preset_data(db, settings, SettingsCipher(settings.app_settings_encryption_key))
        finally:
            db.close()
    finally:
        engine.dispose()


def _build_alembic_config(database_url: str) -> Config:
    project_root = Path(__file__).resolve().parent.parent
    config = Config(str(project_root / "alembic.ini"))
    config.set_main_option("script_location", str(project_root / "alembic"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def _stamp_legacy_schema_if_needed(database_url: str, config: Config) -> None:
    engine, _ = create_engine_and_session(database_url)
    try:
        inspector = inspect(engine)
        table_names = set(inspector.get_table_names())
        current_revision = _get_current_alembic_revision(engine) if "alembic_version" in table_names else None
    finally:
        engine.dispose()

    if current_revision:
        return

    if not table_names.intersection(LEGACY_SCHEMA_TABLES):
        return

    missing_tables = LEGACY_SCHEMA_TABLES - table_names
    if missing_tables:
        missing = ", ".join(sorted(missing_tables))
        raise RuntimeError(
            "Detected a partially initialized legacy schema without alembic_version. "
            f"Missing tables: {missing}."
        )

    command.stamp(config, LEGACY_BASELINE_REVISION)


def _get_current_alembic_revision(engine) -> str | None:
    with engine.connect() as connection:
        row = connection.exec_driver_sql("SELECT version_num FROM alembic_version LIMIT 1").fetchone()
    if not row:
        return None
    return str(row[0]) if row[0] else None


def _build_mysql_admin_url(url: URL) -> URL:
    return url.set(database="")


def _build_create_database_sql(url: URL) -> str:
    database_name = (url.database or "").replace("`", "``")
    create_sql = f"CREATE DATABASE IF NOT EXISTS `{database_name}`"
    charset = str(url.query.get("charset", "")).strip()
    if charset:
        create_sql += f" CHARACTER SET {charset}"
    return create_sql


def _ensure_sqlite_parent_directory(url: URL) -> None:
    database = url.database
    if not database or database == ":memory:":
        return

    path = Path(database).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    path.parent.mkdir(parents=True, exist_ok=True)
