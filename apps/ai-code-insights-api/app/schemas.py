from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TrendGranularity = Literal["day", "week", "month"]
RankingDimension = Literal["sourceIp", "project", "language"]
DistributionDimension = Literal["language", "ide", "sourceType", "hour", "weekday"]


class WebhookPingPayload(BaseModel):
    type: Literal["ai_code_stats_webhook_test"]
    source: str
    timestamp: int


class AiCodeStatsEventPayload(BaseModel):
    eventId: str
    timestamp: int
    sourceType: str
    ide: str
    userId: str | None = None
    userName: str | None = None
    userEmail: str | None = None
    organizationId: str | None = None
    organizationName: str | None = None
    sourceIp: str | None = None
    workspaceName: str
    workspacePath: str
    projectKey: str | None = None
    filePath: str
    relativePath: str
    language: str | None = None
    gitRemoteUrl: str | None = None
    gitBranch: str | None = None
    lineStart: int
    lineEnd: int
    lineCount: int
    codeSnippet: str
    taskId: str | None = None


class AiCodeStatsClientPayload(BaseModel):
    ide: str
    wrapperName: str | None = None
    wrapperVersion: str | None = None
    extensionVersion: str | None = None
    machineId: str | None = None


class AiCodeStatsWindowPayload(BaseModel):
    fromTimestamp: int
    toTimestamp: int
    timezone: str
    generatedAt: int


class AiCodeStatsEnvelopePayload(BaseModel):
    version: str
    source: str
    mode: str
    client: AiCodeStatsClientPayload
    window: AiCodeStatsWindowPayload
    events: list[AiCodeStatsEventPayload]


class DashboardFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_date: date | None = None
    to_date: date | None = None
    organization_id: str | None = None
    source_ip: str | None = None
    project_key: str | None = None
    language: str | None = None
    ide: str | None = None
    source_type: str | None = None


class OverviewCard(BaseModel):
    label: str
    value: int | str
    deltaLabel: str | None = None


class OverviewResponse(BaseModel):
    cards: list[OverviewCard]
    uploadHealth: str
    lastUploadAt: datetime | None
    totalLines: int
    activeSources: int
    activeProjects: int


class TrendPoint(BaseModel):
    bucket: str
    totalLines: int
    eventCount: int


class TrendsResponse(BaseModel):
    granularity: TrendGranularity
    points: list[TrendPoint]


class RankingItem(BaseModel):
    key: str
    label: str
    totalLines: int
    eventCount: int


class RankingsResponse(BaseModel):
    dimension: RankingDimension
    items: list[RankingItem]


class DistributionItem(BaseModel):
    key: str
    label: str
    value: int


class DistributionResponse(BaseModel):
    dimension: DistributionDimension
    items: list[DistributionItem]


class EventRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    eventId: str = Field(alias="event_id")
    occurredAt: datetime = Field(alias="occurred_at")
    sourceIp: str | None = Field(alias="source_ip")
    userName: str | None = Field(alias="user_name")
    organizationId: str | None = Field(alias="organization_id")
    organizationName: str | None = Field(alias="organization_name")
    projectKey: str | None = Field(alias="project_key")
    workspaceName: str = Field(alias="workspace_name")
    filePath: str = Field(alias="file_path")
    relativePath: str = Field(alias="relative_path")
    language: str | None
    ide: str
    sourceType: str = Field(alias="source_type")
    lineCount: int = Field(alias="line_count")
    taskId: str | None = Field(alias="task_id")
    codeSnippet: str = Field(alias="code_snippet")


class EventsResponse(BaseModel):
    page: int
    pageSize: int
    total: int
    items: list[EventRow]


class AIProviderProfile(BaseModel):
    provider: Literal["openai-compatible", "openrouter"]
    name: str
    baseUrl: str
    apiKey: str
    model: str
    temperature: float = 0.2
    maxTokens: int = 1200
    enabled: bool = True


class AISettingsPayload(BaseModel):
    defaultProfile: str | None = None
    profiles: list[AIProviderProfile] = Field(default_factory=list)


class AIAnalyzeRequest(BaseModel):
    filters: DashboardFilters = Field(default_factory=DashboardFilters)
    question: str
    analysisMode: Literal["summary", "compare", "anomaly", "executive"] = "summary"
    widgets: list[str] = Field(default_factory=list)


class AIAnalyzeResponse(BaseModel):
    markdown: str
    citations: list[str]


class IngestResponse(BaseModel):
    accepted: bool
    kind: Literal["webhook_test", "envelope"]
    insertedEvents: int = 0
    duplicateEvents: int = 0


class AIConnectionTestRequest(BaseModel):
    profile: AIProviderProfile


class AIConnectionTestResponse(BaseModel):
    success: bool
    message: str
