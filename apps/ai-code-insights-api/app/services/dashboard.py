from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..models import AiCodeEvent, DimProject, DimUser, FactAiCodeDaily, IngestBatch
from ..schemas import (
    DashboardFilters,
    DistributionDimension,
    DistributionItem,
    DistributionResponse,
    EventRow,
    EventsResponse,
    OverviewCard,
    OverviewResponse,
    RankingDimension,
    RankingItem,
    RankingsResponse,
    TrendPoint,
    TrendGranularity,
    TrendsResponse,
)


def _normalize_date_range(filters: DashboardFilters) -> tuple[date | None, date | None]:
    return filters.from_date, filters.to_date


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


class DashboardService:
    def _filtered_fact_rows(self, db: Session, filters: DashboardFilters) -> list[FactAiCodeDaily]:
        stmt = (
            select(FactAiCodeDaily)
            .options(selectinload(FactAiCodeDaily.user_dim), selectinload(FactAiCodeDaily.project_dim))
            .order_by(FactAiCodeDaily.event_date.asc())
        )

        from_date, to_date = _normalize_date_range(filters)
        if from_date:
            stmt = stmt.where(FactAiCodeDaily.event_date >= from_date)
        if to_date:
            stmt = stmt.where(FactAiCodeDaily.event_date <= to_date)
        if filters.organization_id:
            stmt = stmt.where(FactAiCodeDaily.organization_id == filters.organization_id)
        if filters.source_ip:
            stmt = stmt.join(FactAiCodeDaily.user_dim, isouter=True).where(DimUser.user_key == filters.source_ip)
        if filters.project_key:
            stmt = stmt.join(FactAiCodeDaily.project_dim, isouter=True).where(DimProject.project_key == filters.project_key)
        if filters.language:
            stmt = stmt.where(FactAiCodeDaily.language == filters.language)
        if filters.ide:
            stmt = stmt.where(FactAiCodeDaily.ide == filters.ide)
        if filters.source_type:
            stmt = stmt.where(FactAiCodeDaily.source_type == filters.source_type)

        return list(db.scalars(stmt).all())

    def _filtered_events(self, db: Session, filters: DashboardFilters):
        stmt = select(AiCodeEvent).order_by(AiCodeEvent.occurred_at.desc())
        from_date, to_date = _normalize_date_range(filters)
        if from_date:
            stmt = stmt.where(AiCodeEvent.event_date >= from_date)
        if to_date:
            stmt = stmt.where(AiCodeEvent.event_date <= to_date)
        if filters.organization_id:
            stmt = stmt.where(AiCodeEvent.organization_id == filters.organization_id)
        if filters.source_ip:
            stmt = stmt.where(AiCodeEvent.source_ip == filters.source_ip)
        if filters.project_key:
            stmt = stmt.where(AiCodeEvent.project_key == filters.project_key)
        if filters.language:
            stmt = stmt.where(AiCodeEvent.language == filters.language)
        if filters.ide:
            stmt = stmt.where(AiCodeEvent.ide == filters.ide)
        if filters.source_type:
            stmt = stmt.where(AiCodeEvent.source_type == filters.source_type)
        return stmt

    def get_overview(self, db: Session, filters: DashboardFilters) -> OverviewResponse:
        rows = self._filtered_fact_rows(db, filters)
        total_lines = sum(row.total_lines for row in rows)
        active_sources = len({row.user_dim.user_key for row in rows if row.user_dim})
        active_projects = len({row.project_dim.project_key for row in rows if row.project_dim})
        last_upload = db.scalar(select(IngestBatch).order_by(IngestBatch.created_at.desc()).limit(1))
        last_upload_at = _as_utc(last_upload.created_at) if last_upload else None
        upload_health = "healthy"
        if not last_upload_at or (datetime.now(timezone.utc) - last_upload_at) > timedelta(days=1):
            upload_health = "stale"

        cards = [
            OverviewCard(label="AI code lines", value=total_lines),
            OverviewCard(label="Active source IPs", value=active_sources),
            OverviewCard(label="Active projects", value=active_projects),
            OverviewCard(label="Upload health", value=upload_health),
        ]

        return OverviewResponse(
            cards=cards,
            uploadHealth=upload_health,
            lastUploadAt=last_upload_at,
            totalLines=total_lines,
            activeSources=active_sources,
            activeProjects=active_projects,
        )

    def get_trends(self, db: Session, filters: DashboardFilters, granularity: TrendGranularity) -> TrendsResponse:
        rows = self._filtered_fact_rows(db, filters)
        buckets: dict[str, dict[str, int]] = defaultdict(lambda: {"total_lines": 0, "event_count": 0})

        for row in rows:
            if granularity == "week":
                iso_year, iso_week, _ = row.event_date.isocalendar()
                bucket = f"{iso_year}-W{iso_week:02d}"
            elif granularity == "month":
                bucket = row.event_date.strftime("%Y-%m")
            else:
                bucket = row.event_date.isoformat()
            buckets[bucket]["total_lines"] += row.total_lines
            buckets[bucket]["event_count"] += row.event_count

        points = [
            TrendPoint(bucket=bucket, totalLines=values["total_lines"], eventCount=values["event_count"])
            for bucket, values in sorted(buckets.items(), key=lambda item: item[0])
        ]

        return TrendsResponse(granularity=granularity, points=points)

    def get_rankings(
        self,
        db: Session,
        filters: DashboardFilters,
        dimension: RankingDimension,
        limit: int,
    ) -> RankingsResponse:
        rows = self._filtered_fact_rows(db, filters)
        aggregates: dict[str, RankingItem] = {}

        for row in rows:
            if dimension == "project":
                key = row.project_dim.project_key if row.project_dim else "unknown"
                label = row.project_dim.alias_name or row.project_dim.project_name if row.project_dim else "Unknown project"
            elif dimension == "language":
                key = row.language or "unknown"
                label = row.language or "Unknown language"
            elif dimension == "sourceIp":
                key = row.user_dim.user_key if row.user_dim else "unknown"
                label = row.user_dim.user_key if row.user_dim else "unknown"
            else:
                key = row.language or "unknown"
                label = row.language or "Unknown language"
            if key not in aggregates:
                aggregates[key] = RankingItem(key=key, label=label, totalLines=0, eventCount=0)
            aggregates[key].totalLines += row.total_lines
            aggregates[key].eventCount += row.event_count

        items = sorted(aggregates.values(), key=lambda item: (-item.totalLines, item.label))[:limit]
        return RankingsResponse(dimension=dimension, items=items)

    def get_distribution(
        self,
        db: Session,
        filters: DashboardFilters,
        dimension: DistributionDimension,
    ) -> DistributionResponse:
        if dimension in {"hour", "weekday"}:
            stmt = self._filtered_events(db, filters)
            rows = list(db.scalars(stmt).all())
            counter: dict[str, int] = defaultdict(int)
            for row in rows:
                key = str(row.occurred_at.hour) if dimension == "hour" else str(row.occurred_at.weekday())
                counter[key] += row.line_count
        else:
            rows = self._filtered_fact_rows(db, filters)
            counter = defaultdict(int)
            for row in rows:
                if dimension == "ide":
                    key = row.ide
                elif dimension == "sourceType":
                    key = row.source_type
                else:
                    key = row.language or "unknown"
                counter[key] += row.total_lines

        items = [DistributionItem(key=key, label=key, value=value) for key, value in sorted(counter.items())]
        return DistributionResponse(dimension=dimension, items=items)

    def get_events(self, db: Session, filters: DashboardFilters, page: int, page_size: int) -> EventsResponse:
        stmt = self._filtered_events(db, filters)
        total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        paged_stmt = stmt.offset((page - 1) * page_size).limit(page_size)
        items = [EventRow.model_validate(row) for row in db.scalars(paged_stmt).all()]
        return EventsResponse(page=page, pageSize=page_size, total=total, items=items)
