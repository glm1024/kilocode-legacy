from __future__ import annotations

from datetime import date

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from .bootstrap import initialize_application_database
from .config import Settings, get_settings
from .db import create_engine_and_session, get_db
from .schemas import (
    AIAnalyzeRequest,
    AIAnalyzeResponse,
    AIConnectionTestRequest,
    AIConnectionTestResponse,
    AISettingsPayload,
    AiCodeStatsEnvelopePayload,
    DashboardFilters,
    DistributionDimension,
    DistributionResponse,
    EventsResponse,
    IngestResponse,
    OverviewResponse,
    RankingDimension,
    RankingsResponse,
    TrendGranularity,
    TrendsResponse,
    WebhookPingPayload,
)
from .services.ai import AIAnalysisService, AISettingsService
from .services.dashboard import DashboardService
from .services.ingest import IngestService
from .utils.encryption import SettingsCipher


def _build_filters(
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    organization_id: str | None = Query(default=None),
    source_ip: str | None = Query(default=None),
    project_key: str | None = Query(default=None),
    language: str | None = Query(default=None),
    ide: str | None = Query(default=None),
    source_type: str | None = Query(default=None),
) -> DashboardFilters:
    return DashboardFilters(
        from_date=from_date,
        to_date=to_date,
        organization_id=organization_id,
        source_ip=source_ip,
        project_key=project_key,
        language=language,
        ide=ide,
        source_type=source_type,
    )


def _resolve_request_source_ip(request: Request) -> str | None:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for.strip():
        return forwarded_for.split(",")[0].strip()

    return request.client.host if request.client else None


def create_app(settings_override: Settings | None = None) -> FastAPI:
    settings = settings_override or get_settings()
    initialize_application_database(settings)
    engine, session_local = create_engine_and_session(settings.database_url)

    cipher = SettingsCipher(settings.app_settings_encryption_key)
    dashboard_service = DashboardService()
    ai_settings_service = AISettingsService(cipher)
    ai_analysis_service = AIAnalysisService(ai_settings_service, dashboard_service)
    ingest_service = IngestService()

    app = FastAPI(title=settings.app_name)
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_local = session_local

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/v1/ingest/ai-code-stats", response_model=IngestResponse)
    def ingest_ai_code_stats(
        request: Request,
        payload: WebhookPingPayload | AiCodeStatsEnvelopePayload,
        db: Session = Depends(get_db),
    ) -> IngestResponse:
        if isinstance(payload, WebhookPingPayload):
            return IngestResponse(accepted=True, kind="webhook_test")
        return ingest_service.ingest_envelope(db, payload, _resolve_request_source_ip(request))

    @app.get("/api/v1/dashboard/overview", response_model=OverviewResponse)
    def dashboard_overview(
        filters: DashboardFilters = Depends(_build_filters),
        db: Session = Depends(get_db),
    ) -> OverviewResponse:
        return dashboard_service.get_overview(db, filters)

    @app.get("/api/v1/dashboard/trends", response_model=TrendsResponse)
    def dashboard_trends(
        granularity: TrendGranularity = Query(default="day"),
        filters: DashboardFilters = Depends(_build_filters),
        db: Session = Depends(get_db),
    ) -> TrendsResponse:
        return dashboard_service.get_trends(db, filters, granularity)

    @app.get("/api/v1/dashboard/rankings", response_model=RankingsResponse)
    def dashboard_rankings(
        dimension: RankingDimension = Query(default="sourceIp"),
        limit: int = Query(default=10, ge=1, le=100),
        filters: DashboardFilters = Depends(_build_filters),
        db: Session = Depends(get_db),
    ) -> RankingsResponse:
        return dashboard_service.get_rankings(db, filters, dimension, limit)

    @app.get("/api/v1/dashboard/distribution", response_model=DistributionResponse)
    def dashboard_distribution(
        dimension: DistributionDimension = Query(default="language"),
        filters: DashboardFilters = Depends(_build_filters),
        db: Session = Depends(get_db),
    ) -> DistributionResponse:
        return dashboard_service.get_distribution(db, filters, dimension)

    @app.get("/api/v1/dashboard/events", response_model=EventsResponse, response_model_by_alias=False)
    def dashboard_events(
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=20, ge=1, le=200),
        filters: DashboardFilters = Depends(_build_filters),
        db: Session = Depends(get_db),
    ) -> EventsResponse:
        return dashboard_service.get_events(db, filters, page, page_size)

    @app.get("/api/v1/settings/ai", response_model=AISettingsPayload)
    def get_ai_settings(db: Session = Depends(get_db)) -> AISettingsPayload:
        return ai_settings_service.get_settings(db)

    @app.put("/api/v1/settings/ai", response_model=AISettingsPayload)
    def put_ai_settings(payload: AISettingsPayload, db: Session = Depends(get_db)) -> AISettingsPayload:
        return ai_settings_service.save_settings(db, payload)

    @app.post("/api/v1/settings/ai/test-connection", response_model=AIConnectionTestResponse)
    async def test_ai_connection(payload: AIConnectionTestRequest) -> AIConnectionTestResponse:
        return await ai_analysis_service.test_connection(payload)

    @app.post("/api/v1/ai/analyze", response_model=AIAnalyzeResponse)
    async def ai_analyze(payload: AIAnalyzeRequest, db: Session = Depends(get_db)) -> AIAnalyzeResponse:
        try:
            return await ai_analysis_service.analyze(db, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return app


app = create_app()
