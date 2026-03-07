from __future__ import annotations

from typing import Any

import httpx
from sqlalchemy.orm import Session
from sqlalchemy import select

from ..models import AppSetting
from ..schemas import AIAnalyzeRequest, AIAnalyzeResponse, AIConnectionTestRequest, AIConnectionTestResponse, AISettingsPayload
from ..utils.encryption import SettingsCipher
from .dashboard import DashboardService


AI_SETTINGS_KEY = "ai_provider_settings"


class AISettingsService:
    def __init__(self, cipher: SettingsCipher) -> None:
        self.cipher = cipher

    def get_settings(self, db: Session) -> AISettingsPayload:
        row = db.scalar(select(AppSetting).where(AppSetting.setting_key == AI_SETTINGS_KEY))
        if not row:
            return AISettingsPayload(defaultProfile=None, profiles=[])

        payload = self.cipher.decrypt_json(row.setting_value) if row.encrypted else {}
        return AISettingsPayload.model_validate(payload)

    def save_settings(self, db: Session, payload: AISettingsPayload) -> AISettingsPayload:
        row = db.scalar(select(AppSetting).where(AppSetting.setting_key == AI_SETTINGS_KEY))
        encrypted_value = self.cipher.encrypt_json(payload.model_dump(mode="json"))
        if not row:
            row = AppSetting(setting_key=AI_SETTINGS_KEY, setting_value=encrypted_value, encrypted=True)
            db.add(row)
        else:
            row.setting_value = encrypted_value
            row.encrypted = True
        db.commit()
        return payload


class AIAnalysisService:
    def __init__(self, settings_service: AISettingsService, dashboard_service: DashboardService) -> None:
        self.settings_service = settings_service
        self.dashboard_service = dashboard_service

    def _resolve_profile(self, db: Session):
        settings = self.settings_service.get_settings(db)
        if settings.defaultProfile:
            for profile in settings.profiles:
                if profile.name == settings.defaultProfile and profile.enabled:
                    return profile
        for profile in settings.profiles:
            if profile.enabled:
                return profile
        raise ValueError("No enabled AI profile is configured.")

    async def test_connection(self, request: AIConnectionTestRequest) -> AIConnectionTestResponse:
        try:
            await self._chat_completion(
                request.profile.baseUrl,
                request.profile.apiKey,
                request.profile.model,
                request.profile.temperature,
                min(request.profile.maxTokens, 32),
                [{"role": "user", "content": "Reply with OK"}],
            )
            return AIConnectionTestResponse(success=True, message="Connection succeeded")
        except Exception as exc:  # pragma: no cover - error shape comes from provider
            return AIConnectionTestResponse(success=False, message=str(exc))

    async def analyze(self, db: Session, request: AIAnalyzeRequest) -> AIAnalyzeResponse:
        profile = self._resolve_profile(db)
        overview = self.dashboard_service.get_overview(db, request.filters)
        trends = self.dashboard_service.get_trends(db, request.filters, "day")
        source_ip_rank = self.dashboard_service.get_rankings(db, request.filters, "sourceIp", 5)
        project_rank = self.dashboard_service.get_rankings(db, request.filters, "project", 5)
        language_rank = self.dashboard_service.get_rankings(db, request.filters, "language", 5)

        context: dict[str, Any] = {
            "analysis_mode": request.analysisMode,
            "widgets": request.widgets,
            "overview": overview.model_dump(mode="json"),
            "trends": trends.model_dump(mode="json"),
            "top_source_ips": source_ip_rank.model_dump(mode="json"),
            "top_projects": project_rank.model_dump(mode="json"),
            "top_languages": language_rank.model_dump(mode="json"),
        }

        messages = [
            {
                "role": "system",
                "content": (
                    "You are an analytics copilot. Explain engineering AI usage trends from the provided metrics only. "
                    "Return concise markdown with sections: 结论, 证据, 风险, 建议动作."
                ),
            },
            {
                "role": "user",
                "content": f"Question: {request.question}\n\nMetrics JSON:\n{context}",
            },
        ]
        markdown = await self._chat_completion(
            profile.baseUrl,
            profile.apiKey,
            profile.model,
            profile.temperature,
            profile.maxTokens,
            messages,
        )
        return AIAnalyzeResponse(markdown=markdown, citations=request.widgets or ["overview", "trends"])

    async def _chat_completion(
        self,
        base_url: str,
        api_key: str,
        model: str,
        temperature: float,
        max_tokens: int,
        messages: list[dict[str, str]],
    ) -> str:
        url = base_url.rstrip("/") + "/chat/completions"
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                    "messages": messages,
                },
            )
            response.raise_for_status()
            payload = response.json()
            return payload["choices"][0]["message"]["content"]
