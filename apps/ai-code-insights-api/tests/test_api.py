from __future__ import annotations

import json
import sqlite3

from fastapi.testclient import TestClient

from app.bootstrap import ensure_database_exists
from app.config import Settings
from app.main import create_app
from app.seeds import BOOTSTRAP_META_KEY
from app.services.ai import AI_SETTINGS_KEY


def build_client(tmp_path):
    db_path = tmp_path / "insights.db"
    settings = Settings(
        DATABASE_URL=f"sqlite+pysqlite:///{db_path}",
        APP_SETTINGS_ENCRYPTION_KEY="8j9i6qbIeLlqrvHqYgfdJq0arIpFCmInjY14IjCI-68=",
    )
    app = create_app(settings)
    return TestClient(app)


def build_envelope(event_id: str = "evt-1"):
    return {
        "version": "v1",
        "source": "kilocode-ai-code-stats",
        "mode": "incremental",
        "client": {
            "ide": "vscode",
            "wrapperName": "Kilo Code",
            "wrapperVersion": "1.0.0",
            "extensionVersion": "1.0.0",
            "machineId": "machine-1",
        },
        "window": {
            "fromTimestamp": 1710000000000,
            "toTimestamp": 1710000000000,
            "timezone": "Asia/Shanghai",
            "generatedAt": 1710000000000,
        },
        "events": [
            {
                "eventId": event_id,
                "timestamp": 1710000000000,
                "sourceType": "agent_insert",
                "ide": "vscode",
                "userName": "Alice",
                "organizationId": "org-1",
                "organizationName": "Org 1",
                "sourceIp": "192.168.0.24",
                "workspaceName": "demo",
                "workspacePath": "/workspace/demo",
                "projectKey": "project-1",
                "filePath": "/workspace/demo/src/a.ts",
                "relativePath": "src/a.ts",
                "language": "typescript",
                "gitRemoteUrl": "https://github.com/example/demo.git",
                "gitBranch": "main",
                "lineStart": 2,
                "lineEnd": 3,
                "lineCount": 2,
                "codeSnippet": "const b = 2\nconst c = 3",
                "taskId": "task-1",
            }
        ],
    }


def test_settings_build_database_url_from_mysql_parts():
    settings = Settings(
        MYSQL_HOST="db.internal",
        MYSQL_PORT=3307,
        MYSQL_DATABASE="ai_code_insights",
        MYSQL_USER="ai_code",
        MYSQL_PASSWORD="change-me",
    )

    assert settings.database_url == "mysql+pymysql://ai_code:change-me@db.internal:3307/ai_code_insights?charset=utf8mb4"


def test_webhook_ping(tmp_path):
    client = build_client(tmp_path)
    response = client.post(
        "/api/v1/ingest/ai-code-stats",
        json={"type": "ai_code_stats_webhook_test", "source": "settings", "timestamp": 1710000000000},
    )
    assert response.status_code == 200
    assert response.json()["kind"] == "webhook_test"


def test_healthz(tmp_path):
    client = build_client(tmp_path)
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ingest_is_idempotent_and_drives_queries(tmp_path):
    client = build_client(tmp_path)
    envelope = build_envelope()

    first = client.post("/api/v1/ingest/ai-code-stats", json=envelope)
    second = client.post("/api/v1/ingest/ai-code-stats", json=envelope)

    assert first.status_code == 200
    assert first.json()["insertedEvents"] == 1
    assert second.json()["duplicateEvents"] == 1

    overview = client.get("/api/v1/dashboard/overview")
    rankings = client.get("/api/v1/dashboard/rankings", params={"dimension": "sourceIp"})
    events = client.get("/api/v1/dashboard/events")

    assert overview.status_code == 200
    assert overview.json()["totalLines"] == 2
    assert overview.json()["activeSources"] == 1
    assert rankings.json()["items"][0]["label"] == "192.168.0.24"
    assert events.json()["items"][0]["sourceIp"] == "192.168.0.24"
    assert events.json()["items"][0]["codeSnippet"] == "const b = 2\nconst c = 3"


def test_bootstrap_runs_migrations_and_inserts_seed_rows(tmp_path):
    db_path = tmp_path / "insights.db"
    client = build_client(tmp_path)

    response = client.get("/healthz")
    assert response.status_code == 200

    with sqlite3.connect(db_path) as conn:
        tables = {row[0] for row in conn.execute("select name from sqlite_master where type = 'table'")}
        seed_keys = {row[0] for row in conn.execute("select setting_key from app_settings")}

    assert "alembic_version" in tables
    assert "app_settings" in tables
    assert AI_SETTINGS_KEY in seed_keys
    assert BOOTSTRAP_META_KEY in seed_keys


def test_ai_settings_are_encrypted_at_rest(tmp_path):
    db_path = tmp_path / "insights.db"
    client = build_client(tmp_path)
    payload = {
        "defaultProfile": "internal-openai",
        "profiles": [
            {
                "provider": "openai-compatible",
                "name": "internal-openai",
                "baseUrl": "https://llm.example.com/v1",
                "apiKey": "secret-key",
                "model": "gpt-4.1-mini",
                "temperature": 0.2,
                "maxTokens": 1200,
                "enabled": True,
            }
        ],
    }

    put_resp = client.put("/api/v1/settings/ai", json=payload)
    get_resp = client.get("/api/v1/settings/ai")

    assert put_resp.status_code == 200
    assert get_resp.json()["profiles"][0]["apiKey"] == "secret-key"

    with sqlite3.connect(db_path) as conn:
        row = conn.execute("select setting_value from app_settings where setting_key = ?", ("ai_provider_settings",)).fetchone()

    assert row is not None
    assert "secret-key" not in row[0]


def test_seed_ai_settings_json_bootstraps_default_profile(tmp_path):
    db_path = tmp_path / "seeded.db"
    seed_payload = {
        "defaultProfile": "seeded-openai",
        "profiles": [
            {
                "provider": "openai-compatible",
                "name": "seeded-openai",
                "baseUrl": "https://llm.example.com/v1",
                "apiKey": "seed-secret",
                "model": "gpt-4.1-mini",
                "temperature": 0.2,
                "maxTokens": 1200,
                "enabled": True,
            }
        ],
    }
    settings = Settings(
        DATABASE_URL=f"sqlite+pysqlite:///{db_path}",
        APP_SETTINGS_ENCRYPTION_KEY="8j9i6qbIeLlqrvHqYgfdJq0arIpFCmInjY14IjCI-68=",
        SEED_AI_SETTINGS_JSON=json.dumps(seed_payload),
    )
    client = TestClient(create_app(settings))

    response = client.get("/api/v1/settings/ai")

    assert response.status_code == 200
    assert response.json() == seed_payload


def test_mysql_database_is_created_before_migrations(monkeypatch):
    executed_sql: list[str] = []
    captured = {}

    class _FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def exec_driver_sql(self, sql: str) -> None:
            executed_sql.append(sql)

    class _FakeEngine:
        def connect(self):
            return _FakeConnection()

        def dispose(self) -> None:
            captured["disposed"] = True

    def _fake_create_engine(url, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs
        return _FakeEngine()

    monkeypatch.setattr("app.bootstrap.create_engine", _fake_create_engine)

    ensure_database_exists("mysql+pymysql://root:root@db.internal:3306/ai_code_insights?charset=utf8mb4")

    assert captured["url"].database == ""
    assert captured["kwargs"]["isolation_level"] == "AUTOCOMMIT"
    assert executed_sql == ["CREATE DATABASE IF NOT EXISTS `ai_code_insights` CHARACTER SET utf8mb4"]
    assert captured["disposed"] is True


class _MockResponse:
    def __init__(self, content: str):
        self._content = content

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"choices": [{"message": {"content": self._content}}]}


class _MockAsyncClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, headers=None, json=None):
        if json and json.get("messages", [{}])[-1].get("content") == "Reply with OK":
            return _MockResponse("OK")
        return _MockResponse("## 结论\nAI 使用增长稳定。")


def test_ai_analyze_and_connection_use_configured_profile(tmp_path, monkeypatch):
    client = build_client(tmp_path)
    monkeypatch.setattr("app.services.ai.httpx.AsyncClient", _MockAsyncClient)

    settings_payload = {
        "defaultProfile": "internal-openai",
        "profiles": [
            {
                "provider": "openai-compatible",
                "name": "internal-openai",
                "baseUrl": "https://llm.example.com/v1",
                "apiKey": "secret-key",
                "model": "gpt-4.1-mini",
                "temperature": 0.2,
                "maxTokens": 1200,
                "enabled": True,
            }
        ],
    }
    client.put("/api/v1/settings/ai", json=settings_payload)
    client.post("/api/v1/ingest/ai-code-stats", json=build_envelope())

    test_resp = client.post(
        "/api/v1/settings/ai/test-connection",
        json={"profile": settings_payload["profiles"][0]},
    )
    analyze_resp = client.post(
        "/api/v1/ai/analyze",
        json={
            "filters": {"language": "typescript"},
            "question": "Summarize the current usage.",
            "analysisMode": "summary",
            "widgets": ["overview", "trends"],
        },
    )

    assert test_resp.status_code == 200
    assert test_resp.json() == {"success": True, "message": "Connection succeeded"}
    assert analyze_resp.status_code == 200
    assert "结论" in analyze_resp.json()["markdown"]
