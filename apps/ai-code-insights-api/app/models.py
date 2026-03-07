from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class IngestBatch(Base):
    __tablename__ = "ingest_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(64), nullable=False)
    version: Mapped[str] = mapped_column(String(16), nullable=False)
    mode: Mapped[str] = mapped_column(String(32), nullable=False)
    ide: Mapped[str | None] = mapped_column(String(32))
    wrapper_name: Mapped[str | None] = mapped_column(String(128))
    wrapper_version: Mapped[str | None] = mapped_column(String(64))
    extension_version: Mapped[str | None] = mapped_column(String(64))
    machine_id: Mapped[str | None] = mapped_column(String(128))
    source_ip: Mapped[str | None] = mapped_column(String(64), index=True)
    timezone: Mapped[str | None] = mapped_column(String(64))
    from_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    to_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payload_event_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    inserted_event_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    duplicate_event_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    events: Mapped[list["AiCodeEvent"]] = relationship(back_populates="batch")


class DimUser(Base, TimestampMixin):
    __tablename__ = "dim_users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_key: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    display_name: Mapped[str | None] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(255))
    organization_id: Mapped[str | None] = mapped_column(String(128), index=True)
    organization_name: Mapped[str | None] = mapped_column(String(255))


class DimProject(Base, TimestampMixin):
    __tablename__ = "dim_projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    alias_name: Mapped[str | None] = mapped_column(String(255))
    git_remote_url: Mapped[str | None] = mapped_column(Text)
    workspace_path: Mapped[str | None] = mapped_column(Text)


class AiCodeEvent(Base):
    __tablename__ = "ai_code_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("ingest_batches.id"))
    user_dim_id: Mapped[int | None] = mapped_column(ForeignKey("dim_users.id"), index=True)
    project_dim_id: Mapped[int | None] = mapped_column(ForeignKey("dim_projects.id"), index=True)
    ide: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    source_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    source_ip: Mapped[str | None] = mapped_column(String(64), index=True)
    user_id: Mapped[str | None] = mapped_column(String(128), index=True)
    user_name: Mapped[str | None] = mapped_column(String(255))
    user_email: Mapped[str | None] = mapped_column(String(255))
    organization_id: Mapped[str | None] = mapped_column(String(128), index=True)
    organization_name: Mapped[str | None] = mapped_column(String(255))
    workspace_name: Mapped[str] = mapped_column(String(255), nullable=False)
    workspace_path: Mapped[str] = mapped_column(Text, nullable=False)
    project_key: Mapped[str | None] = mapped_column(String(64), index=True)
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    relative_path: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str | None] = mapped_column(String(64), index=True)
    git_remote_url: Mapped[str | None] = mapped_column(Text)
    git_branch: Mapped[str | None] = mapped_column(String(255))
    line_start: Mapped[int] = mapped_column(Integer, nullable=False)
    line_end: Mapped[int] = mapped_column(Integer, nullable=False)
    line_count: Mapped[int] = mapped_column(Integer, nullable=False)
    code_snippet: Mapped[str] = mapped_column(Text, nullable=False)
    task_id: Mapped[str | None] = mapped_column(String(128), index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    event_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    batch: Mapped[IngestBatch | None] = relationship(back_populates="events")
    user_dim: Mapped[DimUser | None] = relationship()
    project_dim: Mapped[DimProject | None] = relationship()


class FactAiCodeDaily(Base, TimestampMixin):
    __tablename__ = "fact_ai_code_daily"
    __table_args__ = (
        UniqueConstraint(
            "event_date",
            "user_dim_id",
            "project_dim_id",
            "language",
            "ide",
            "source_type",
            "organization_id",
            name="uq_fact_ai_code_daily",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    user_dim_id: Mapped[int | None] = mapped_column(ForeignKey("dim_users.id"), index=True)
    project_dim_id: Mapped[int | None] = mapped_column(ForeignKey("dim_projects.id"), index=True)
    organization_id: Mapped[str | None] = mapped_column(String(128), index=True)
    organization_name: Mapped[str | None] = mapped_column(String(255))
    language: Mapped[str | None] = mapped_column(String(64), index=True)
    ide: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    source_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    total_lines: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    event_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    active_task_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    user_dim: Mapped[DimUser | None] = relationship()
    project_dim: Mapped[DimProject | None] = relationship()


class AppSetting(Base, TimestampMixin):
    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    setting_key: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    setting_value: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
