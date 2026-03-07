from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AiCodeEvent, DimProject, DimUser, FactAiCodeDaily, IngestBatch
from ..schemas import AiCodeStatsEnvelopePayload, AiCodeStatsEventPayload, IngestResponse


def _to_datetime(timestamp_ms: int) -> datetime:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)


def _project_key_for_event(event: AiCodeStatsEventPayload) -> str:
    seed = event.projectKey or event.gitRemoteUrl or event.workspacePath
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]


def _language_for_event(event: AiCodeStatsEventPayload) -> str:
    if event.language:
        return event.language

    suffix = Path(event.relativePath).suffix.lower().lstrip(".")
    return suffix or "unknown"


def _source_ip_for_event(event: AiCodeStatsEventPayload, fallback_source_ip: str | None) -> str:
    return (event.sourceIp or fallback_source_ip or "unknown").strip() or "unknown"


class IngestService:
    def _get_or_create_user(self, db: Session, event: AiCodeStatsEventPayload, source_ip: str) -> DimUser | None:
        user_key = source_ip
        existing = db.scalar(select(DimUser).where(DimUser.user_key == user_key))
        if existing:
            existing.display_name = event.userName or existing.display_name
            existing.email = event.userEmail or existing.email
            existing.organization_id = event.organizationId or existing.organization_id
            existing.organization_name = event.organizationName or existing.organization_name
            return existing

        user = DimUser(
            user_key=user_key,
            display_name=event.userName or user_key,
            email=event.userEmail,
            organization_id=event.organizationId,
            organization_name=event.organizationName,
        )
        db.add(user)
        db.flush()
        return user

    def _get_or_create_project(self, db: Session, event: AiCodeStatsEventPayload) -> DimProject:
        project_key = _project_key_for_event(event)
        existing = db.scalar(select(DimProject).where(DimProject.project_key == project_key))
        if existing:
            existing.project_name = event.workspaceName or existing.project_name
            existing.git_remote_url = event.gitRemoteUrl or existing.git_remote_url
            existing.workspace_path = event.workspacePath or existing.workspace_path
            return existing

        project = DimProject(
            project_key=project_key,
            project_name=event.workspaceName,
            git_remote_url=event.gitRemoteUrl,
            workspace_path=event.workspacePath,
        )
        db.add(project)
        db.flush()
        return project

    def _apply_fact_increment(
        self,
        db: Session,
        event_date,
        user_dim_id,
        project_dim_id,
        organization_id,
        organization_name,
        language,
        ide,
        source_type,
        total_lines,
        event_count,
        active_task_count,
    ) -> None:
        fact = db.scalar(
            select(FactAiCodeDaily).where(
                FactAiCodeDaily.event_date == event_date,
                FactAiCodeDaily.user_dim_id == user_dim_id,
                FactAiCodeDaily.project_dim_id == project_dim_id,
                FactAiCodeDaily.language == language,
                FactAiCodeDaily.ide == ide,
                FactAiCodeDaily.source_type == source_type,
                FactAiCodeDaily.organization_id == organization_id,
            )
        )
        if fact:
            fact.total_lines += total_lines
            fact.event_count += event_count
            fact.active_task_count += active_task_count
            return

        db.add(
            FactAiCodeDaily(
                event_date=event_date,
                user_dim_id=user_dim_id,
                project_dim_id=project_dim_id,
                organization_id=organization_id,
                organization_name=organization_name,
                language=language,
                ide=ide,
                source_type=source_type,
                total_lines=total_lines,
                event_count=event_count,
                active_task_count=active_task_count,
            )
        )

    def ingest_envelope(
        self,
        db: Session,
        envelope: AiCodeStatsEnvelopePayload,
        fallback_source_ip: str | None = None,
    ) -> IngestResponse:
        payload_event_count = len(envelope.events)
        batch_source_ip = next((event.sourceIp for event in envelope.events if event.sourceIp), fallback_source_ip)
        batch = IngestBatch(
            source=envelope.source,
            version=envelope.version,
            mode=envelope.mode,
            ide=envelope.client.ide,
            wrapper_name=envelope.client.wrapperName,
            wrapper_version=envelope.client.wrapperVersion,
            extension_version=envelope.client.extensionVersion,
            machine_id=envelope.client.machineId,
            source_ip=batch_source_ip,
            timezone=envelope.window.timezone,
            from_timestamp=_to_datetime(envelope.window.fromTimestamp),
            to_timestamp=_to_datetime(envelope.window.toTimestamp),
            generated_at=_to_datetime(envelope.window.generatedAt),
            payload_event_count=payload_event_count,
        )
        db.add(batch)
        db.flush()

        existing_ids = set(
            db.scalars(select(AiCodeEvent.event_id).where(AiCodeEvent.event_id.in_([event.eventId for event in envelope.events]))).all()
        )
        inserted_count = 0
        duplicate_count = 0
        fact_increments = defaultdict(lambda: {"total_lines": 0, "event_count": 0, "tasks": set()})

        for event in envelope.events:
            if event.eventId in existing_ids:
                duplicate_count += 1
                continue

            source_ip = _source_ip_for_event(event, fallback_source_ip)
            user = self._get_or_create_user(db, event, source_ip)
            project = self._get_or_create_project(db, event)
            occurred_at = _to_datetime(event.timestamp)
            event_date = occurred_at.date()
            language = _language_for_event(event)

            db.add(
                AiCodeEvent(
                    event_id=event.eventId,
                    batch_id=batch.id,
                    user_dim_id=user.id if user else None,
                    project_dim_id=project.id,
                    ide=event.ide,
                    source_type=event.sourceType,
                    source_ip=source_ip,
                    user_id=event.userId,
                    user_name=event.userName,
                    user_email=event.userEmail,
                    organization_id=event.organizationId,
                    organization_name=event.organizationName,
                    workspace_name=event.workspaceName,
                    workspace_path=event.workspacePath,
                    project_key=project.project_key,
                    file_path=event.filePath,
                    relative_path=event.relativePath,
                    language=language,
                    git_remote_url=event.gitRemoteUrl,
                    git_branch=event.gitBranch,
                    line_start=event.lineStart,
                    line_end=event.lineEnd,
                    line_count=event.lineCount,
                    code_snippet=event.codeSnippet,
                    task_id=event.taskId,
                    occurred_at=occurred_at,
                    event_date=event_date,
                )
            )
            inserted_count += 1
            fact_key = (
                event_date,
                user.id if user else None,
                project.id,
                event.organizationId,
                event.organizationName,
                language,
                event.ide,
                event.sourceType,
            )
            increment = fact_increments[fact_key]
            increment["total_lines"] += event.lineCount
            increment["event_count"] += 1
            if event.taskId:
                increment["tasks"].add(event.taskId)

        for key, value in fact_increments.items():
            event_date, user_dim_id, project_dim_id, organization_id, organization_name, language, ide, source_type = key
            self._apply_fact_increment(
                db,
                event_date,
                user_dim_id,
                project_dim_id,
                organization_id,
                organization_name,
                language,
                ide,
                source_type,
                value["total_lines"],
                value["event_count"],
                len(value["tasks"]),
            )

        batch.inserted_event_count = inserted_count
        batch.duplicate_event_count = duplicate_count
        db.commit()

        return IngestResponse(
            accepted=True,
            kind="envelope",
            insertedEvents=inserted_count,
            duplicateEvents=duplicate_count,
        )
