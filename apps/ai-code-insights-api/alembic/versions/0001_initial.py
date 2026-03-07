from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ingest_batches",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("version", sa.String(length=16), nullable=False),
        sa.Column("mode", sa.String(length=32), nullable=False),
        sa.Column("ide", sa.String(length=32)),
        sa.Column("wrapper_name", sa.String(length=128)),
        sa.Column("wrapper_version", sa.String(length=64)),
        sa.Column("extension_version", sa.String(length=64)),
        sa.Column("machine_id", sa.String(length=128)),
        sa.Column("source_ip", sa.String(length=64)),
        sa.Column("timezone", sa.String(length=64)),
        sa.Column("from_timestamp", sa.DateTime(timezone=True)),
        sa.Column("to_timestamp", sa.DateTime(timezone=True)),
        sa.Column("generated_at", sa.DateTime(timezone=True)),
        sa.Column("payload_event_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("inserted_event_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("duplicate_event_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "dim_users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_key", sa.String(length=128), nullable=False, unique=True),
        sa.Column("display_name", sa.String(length=255)),
        sa.Column("email", sa.String(length=255)),
        sa.Column("organization_id", sa.String(length=128)),
        sa.Column("organization_name", sa.String(length=255)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "dim_projects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_key", sa.String(length=64), nullable=False, unique=True),
        sa.Column("project_name", sa.String(length=255), nullable=False),
        sa.Column("alias_name", sa.String(length=255)),
        sa.Column("git_remote_url", sa.Text()),
        sa.Column("workspace_path", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "app_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("setting_key", sa.String(length=128), nullable=False, unique=True),
        sa.Column("setting_value", sa.Text(), nullable=False),
        sa.Column("encrypted", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "ai_code_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_id", sa.String(length=128), nullable=False, unique=True),
        sa.Column("batch_id", sa.Integer(), sa.ForeignKey("ingest_batches.id")),
        sa.Column("user_dim_id", sa.Integer(), sa.ForeignKey("dim_users.id")),
        sa.Column("project_dim_id", sa.Integer(), sa.ForeignKey("dim_projects.id")),
        sa.Column("ide", sa.String(length=32), nullable=False),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column("source_ip", sa.String(length=64)),
        sa.Column("user_id", sa.String(length=128)),
        sa.Column("user_name", sa.String(length=255)),
        sa.Column("user_email", sa.String(length=255)),
        sa.Column("organization_id", sa.String(length=128)),
        sa.Column("organization_name", sa.String(length=255)),
        sa.Column("workspace_name", sa.String(length=255), nullable=False),
        sa.Column("workspace_path", sa.Text(), nullable=False),
        sa.Column("project_key", sa.String(length=64)),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("relative_path", sa.Text(), nullable=False),
        sa.Column("language", sa.String(length=64)),
        sa.Column("git_remote_url", sa.Text()),
        sa.Column("git_branch", sa.String(length=255)),
        sa.Column("line_start", sa.Integer(), nullable=False),
        sa.Column("line_end", sa.Integer(), nullable=False),
        sa.Column("line_count", sa.Integer(), nullable=False),
        sa.Column("code_snippet", sa.Text(), nullable=False),
        sa.Column("task_id", sa.String(length=128)),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_date", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "fact_ai_code_daily",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_date", sa.Date(), nullable=False),
        sa.Column("user_dim_id", sa.Integer(), sa.ForeignKey("dim_users.id")),
        sa.Column("project_dim_id", sa.Integer(), sa.ForeignKey("dim_projects.id")),
        sa.Column("organization_id", sa.String(length=128)),
        sa.Column("organization_name", sa.String(length=255)),
        sa.Column("language", sa.String(length=64)),
        sa.Column("ide", sa.String(length=32), nullable=False),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column("total_lines", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("event_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("active_task_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
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


def downgrade() -> None:
    op.drop_table("fact_ai_code_daily")
    op.drop_table("ai_code_events")
    op.drop_table("app_settings")
    op.drop_table("dim_projects")
    op.drop_table("dim_users")
    op.drop_table("ingest_batches")
