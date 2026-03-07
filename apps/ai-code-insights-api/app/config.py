from __future__ import annotations

from functools import lru_cache
from urllib.parse import quote_plus

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_ENCRYPTION_KEY = "8j9i6qbIeLlqrvHqYgfdJq0arIpFCmInjY14IjCI-68="
DEFAULT_SQLITE_URL = "sqlite+pysqlite:///./ai_code_insights.db"
DEFAULT_BOOTSTRAP_SEED_VERSION = "2026-03-07.1"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    app_name: str = "AI Code Insights API"
    database_url: str | None = Field(default=None, alias="DATABASE_URL")
    mysql_host: str | None = Field(default=None, alias="MYSQL_HOST")
    mysql_port: int = Field(default=3306, alias="MYSQL_PORT")
    mysql_database: str = Field(default="ai_code_insights", alias="MYSQL_DATABASE")
    mysql_user: str = Field(default="root", alias="MYSQL_USER")
    mysql_password: str = Field(default="root", alias="MYSQL_PASSWORD")
    mysql_charset: str = Field(default="utf8mb4", alias="MYSQL_CHARSET")
    app_settings_encryption_key: str = Field(
        default=DEFAULT_ENCRYPTION_KEY,
        alias="APP_SETTINGS_ENCRYPTION_KEY",
    )
    bootstrap_seed_version: str = Field(
        default=DEFAULT_BOOTSTRAP_SEED_VERSION,
        alias="BOOTSTRAP_SEED_VERSION",
    )
    seed_ai_settings_json: str | None = Field(default=None, alias="SEED_AI_SETTINGS_JSON")
    api_base_url: str = Field(default="http://localhost:18080", alias="API_BASE_URL")
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])

    @model_validator(mode="after")
    def _resolve_database_url(self) -> "Settings":
        if self.database_url:
            return self

        if self.mysql_host:
            user = quote_plus(self.mysql_user)
            password = quote_plus(self.mysql_password)
            database = quote_plus(self.mysql_database)
            self.database_url = (
                f"mysql+pymysql://{user}:{password}@{self.mysql_host}:{self.mysql_port}/{database}"
                f"?charset={self.mysql_charset}"
            )
            return self

        self.database_url = DEFAULT_SQLITE_URL
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
