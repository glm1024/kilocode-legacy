from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from random import Random
from typing import Iterable


DEFAULT_DEMO_EVENT_COUNT = 1000
DEFAULT_DEMO_BATCH_SIZE = 100
DEFAULT_DEMO_DAYS = 180
DEFAULT_DEMO_SEED = 20260307


@dataclass(frozen=True)
class SourceProfile:
    key: str
    source_ip: str
    user_name: str
    organization_id: str
    organization_name: str
    user_email: str
    ide_weights: tuple[tuple[str, float], ...]
    project_weights: tuple[tuple[str, float], ...]
    activity_weight: float


@dataclass(frozen=True)
class ProjectProfile:
    key: str
    workspace_name: str
    workspace_path: str
    git_remote_url: str
    branches: tuple[str, ...]
    language_weights: tuple[tuple[str, float], ...]


@dataclass(frozen=True)
class LanguageProfile:
    key: str
    extension: str
    directories: tuple[str, ...]


SOURCE_PROFILES: tuple[SourceProfile, ...] = (
    SourceProfile(
        key="dev-a01",
        source_ip="10.24.8.11",
        user_name="Ava Chen",
        organization_id="org-platform",
        organization_name="Platform Engineering",
        user_email="ava.chen@example.com",
        ide_weights=(("vscode", 4.2), ("cursor", 2.1), ("jetbrains", 0.5)),
        project_weights=(("phoenix-trade", 3.5), ("mercury-gateway", 2.2), ("atlas-data", 1.1)),
        activity_weight=4.8,
    ),
    SourceProfile(
        key="dev-a02",
        source_ip="10.24.8.12",
        user_name="Liam Park",
        organization_id="org-platform",
        organization_name="Platform Engineering",
        user_email="liam.park@example.com",
        ide_weights=(("cursor", 4.0), ("vscode", 1.8), ("jetbrains", 0.4)),
        project_weights=(("phoenix-trade", 3.0), ("nebula-risk", 1.9), ("horizon-mobile", 0.7)),
        activity_weight=4.5,
    ),
    SourceProfile(
        key="dev-b01",
        source_ip="10.24.8.21",
        user_name="Mia Lopez",
        organization_id="org-retail",
        organization_name="Retail Growth",
        user_email="mia.lopez@example.com",
        ide_weights=(("vscode", 3.8), ("cursor", 1.9), ("jetbrains", 0.5)),
        project_weights=(("orion-ops", 2.6), ("growth-service", 2.3), ("atlas-data", 0.9)),
        activity_weight=3.9,
    ),
    SourceProfile(
        key="dev-b02",
        source_ip="10.24.8.22",
        user_name="Noah Kim",
        organization_id="org-retail",
        organization_name="Retail Growth",
        user_email="noah.kim@example.com",
        ide_weights=(("vscode", 2.9), ("jetbrains", 2.2), ("cursor", 0.8)),
        project_weights=(("growth-service", 2.9), ("atlas-data", 1.4), ("ops-observability", 1.0)),
        activity_weight=3.4,
    ),
    SourceProfile(
        key="dev-c01",
        source_ip="10.24.8.31",
        user_name="Olivia Singh",
        organization_id="org-finance",
        organization_name="Finance Systems",
        user_email="olivia.singh@example.com",
        ide_weights=(("jetbrains", 3.6), ("vscode", 2.0), ("cursor", 0.6)),
        project_weights=(("nebula-risk", 3.2), ("mercury-gateway", 1.8), ("atlas-data", 1.0)),
        activity_weight=4.0,
    ),
    SourceProfile(
        key="dev-c02",
        source_ip="10.24.8.32",
        user_name="Ethan Brooks",
        organization_id="org-finance",
        organization_name="Finance Systems",
        user_email="ethan.brooks@example.com",
        ide_weights=(("jetbrains", 2.8), ("cursor", 1.5), ("vscode", 1.1)),
        project_weights=(("nebula-risk", 2.5), ("mercury-gateway", 2.0), ("delta-clearing", 1.1)),
        activity_weight=3.6,
    ),
    SourceProfile(
        key="dev-d01",
        source_ip="10.24.8.41",
        user_name="Sophia Green",
        organization_id="org-data",
        organization_name="Data Intelligence",
        user_email="sophia.green@example.com",
        ide_weights=(("vscode", 3.4), ("cursor", 2.0), ("jetbrains", 0.2)),
        project_weights=(("atlas-data", 3.8), ("insight-portal", 1.4), ("ops-observability", 1.0)),
        activity_weight=4.1,
    ),
    SourceProfile(
        key="dev-d02",
        source_ip="10.24.8.42",
        user_name="James Reed",
        organization_id="org-data",
        organization_name="Data Intelligence",
        user_email="james.reed@example.com",
        ide_weights=(("cursor", 3.2), ("vscode", 2.1), ("jetbrains", 0.3)),
        project_weights=(("atlas-data", 3.0), ("insight-portal", 2.0), ("horizon-mobile", 0.8)),
        activity_weight=3.7,
    ),
    SourceProfile(
        key="dev-e01",
        source_ip="10.24.8.51",
        user_name="Charlotte Diaz",
        organization_id="org-platform",
        organization_name="Platform Engineering",
        user_email="charlotte.diaz@example.com",
        ide_weights=(("vscode", 2.6), ("cursor", 2.4), ("jetbrains", 0.5)),
        project_weights=(("ops-observability", 2.9), ("mercury-gateway", 1.9), ("phoenix-trade", 1.3)),
        activity_weight=3.1,
    ),
    SourceProfile(
        key="dev-e02",
        source_ip="10.24.8.52",
        user_name="Benjamin Hall",
        organization_id="org-platform",
        organization_name="Platform Engineering",
        user_email="benjamin.hall@example.com",
        ide_weights=(("cursor", 2.7), ("vscode", 1.9), ("jetbrains", 0.7)),
        project_weights=(("ops-observability", 2.2), ("delta-clearing", 1.8), ("nebula-risk", 1.1)),
        activity_weight=2.8,
    ),
    SourceProfile(
        key="dev-f01",
        source_ip="10.24.8.61",
        user_name="Amelia Foster",
        organization_id="org-retail",
        organization_name="Retail Growth",
        user_email="amelia.foster@example.com",
        ide_weights=(("vscode", 2.3), ("cursor", 2.0), ("jetbrains", 0.9)),
        project_weights=(("horizon-mobile", 2.8), ("growth-service", 1.9), ("insight-portal", 1.0)),
        activity_weight=2.9,
    ),
    SourceProfile(
        key="dev-f02",
        source_ip="10.24.8.62",
        user_name="Lucas Rivera",
        organization_id="org-finance",
        organization_name="Finance Systems",
        user_email="lucas.rivera@example.com",
        ide_weights=(("jetbrains", 2.2), ("vscode", 1.8), ("cursor", 1.4)),
        project_weights=(("delta-clearing", 2.6), ("mercury-gateway", 1.7), ("phoenix-trade", 0.9)),
        activity_weight=2.7,
    ),
)

PROJECTS: tuple[ProjectProfile, ...] = (
    ProjectProfile(
        key="phoenix-trade",
        workspace_name="Phoenix Trade Core",
        workspace_path="/srv/workspaces/phoenix-trade",
        git_remote_url="git@github.com:demo/phoenix-trade.git",
        branches=("main", "release/2026q1", "feature/risk-hedge"),
        language_weights=(("typescript", 3.8), ("python", 1.2), ("yaml", 0.8), ("sql", 0.7)),
    ),
    ProjectProfile(
        key="nebula-risk",
        workspace_name="Nebula Risk Engine",
        workspace_path="/srv/workspaces/nebula-risk",
        git_remote_url="git@github.com:demo/nebula-risk.git",
        branches=("main", "release/2026q1", "feature/scoring"),
        language_weights=(("java", 3.2), ("kotlin", 2.4), ("sql", 1.2), ("yaml", 0.6)),
    ),
    ProjectProfile(
        key="atlas-data",
        workspace_name="Atlas Data Hub",
        workspace_path="/srv/workspaces/atlas-data",
        git_remote_url="git@github.com:demo/atlas-data.git",
        branches=("main", "feature/warehouse-tuning", "feature/data-contracts"),
        language_weights=(("python", 3.6), ("sql", 2.6), ("yaml", 1.4), ("typescript", 0.8)),
    ),
    ProjectProfile(
        key="mercury-gateway",
        workspace_name="Mercury Gateway",
        workspace_path="/srv/workspaces/mercury-gateway",
        git_remote_url="git@github.com:demo/mercury-gateway.git",
        branches=("main", "release/2026q1", "feature/rate-limit"),
        language_weights=(("go", 3.5), ("yaml", 1.4), ("typescript", 1.0), ("sql", 0.5)),
    ),
    ProjectProfile(
        key="orion-ops",
        workspace_name="Orion Ops Console",
        workspace_path="/srv/workspaces/orion-ops",
        git_remote_url="git@github.com:demo/orion-ops.git",
        branches=("main", "feature/workflow-board", "feature/incident-view"),
        language_weights=(("typescript", 3.7), ("yaml", 1.1), ("python", 0.6), ("sql", 0.4)),
    ),
    ProjectProfile(
        key="growth-service",
        workspace_name="Growth Service",
        workspace_path="/srv/workspaces/growth-service",
        git_remote_url="git@github.com:demo/growth-service.git",
        branches=("main", "feature/referral-loop", "feature/segments"),
        language_weights=(("typescript", 2.3), ("python", 2.0), ("sql", 1.2), ("yaml", 0.7)),
    ),
    ProjectProfile(
        key="ops-observability",
        workspace_name="Ops Observability",
        workspace_path="/srv/workspaces/ops-observability",
        git_remote_url="git@github.com:demo/ops-observability.git",
        branches=("main", "feature/slo-radar", "feature/capacity-map"),
        language_weights=(("go", 1.9), ("python", 1.8), ("yaml", 1.7), ("rust", 0.9)),
    ),
    ProjectProfile(
        key="horizon-mobile",
        workspace_name="Horizon Mobile Backend",
        workspace_path="/srv/workspaces/horizon-mobile",
        git_remote_url="git@github.com:demo/horizon-mobile.git",
        branches=("main", "feature/engagement-boost", "release/2026q1"),
        language_weights=(("kotlin", 3.5), ("java", 1.5), ("yaml", 0.7), ("sql", 0.5)),
    ),
    ProjectProfile(
        key="delta-clearing",
        workspace_name="Delta Clearing",
        workspace_path="/srv/workspaces/delta-clearing",
        git_remote_url="git@github.com:demo/delta-clearing.git",
        branches=("main", "feature/post-trade", "feature/reconciliation"),
        language_weights=(("java", 2.0), ("go", 2.0), ("sql", 1.5), ("yaml", 0.5)),
    ),
    ProjectProfile(
        key="insight-portal",
        workspace_name="Insight Portal",
        workspace_path="/srv/workspaces/insight-portal",
        git_remote_url="git@github.com:demo/insight-portal.git",
        branches=("main", "feature/executive-summary", "feature/copilot-panel"),
        language_weights=(("typescript", 3.6), ("rust", 1.0), ("yaml", 0.9), ("python", 0.7)),
    ),
)

LANGUAGES: dict[str, LanguageProfile] = {
    "typescript": LanguageProfile("typescript", "ts", ("src", "lib", "ui")),
    "python": LanguageProfile("python", "py", ("services", "jobs", "pipelines")),
    "go": LanguageProfile("go", "go", ("internal", "pkg", "cmd")),
    "java": LanguageProfile("java", "java", ("src/main/java",)),
    "kotlin": LanguageProfile("kotlin", "kt", ("src/main/kotlin",)),
    "sql": LanguageProfile("sql", "sql", ("db/migrations", "db/views", "warehouse/models")),
    "yaml": LanguageProfile("yaml", "yaml", ("deploy", ".github/workflows", "configs")),
    "rust": LanguageProfile("rust", "rs", ("crates", "services", "workers")),
}

SOURCE_TYPES: tuple[tuple[str, float], ...] = (
    ("agent_insert", 4.3),
    ("agent_refactor", 2.7),
    ("bulk_apply", 1.5),
    ("test_fix", 1.9),
    ("config_update", 1.1),
)

ANOMALY_DAY_OFFSETS = {24, 51, 88, 120, 151, 171}
MEGA_EVENT_OFFSETS = {53, 208, 487, 701, 913}


def generate_demo_envelopes(
    event_count: int = DEFAULT_DEMO_EVENT_COUNT,
    batch_size: int = DEFAULT_DEMO_BATCH_SIZE,
    seed: int = DEFAULT_DEMO_SEED,
    span_days: int = DEFAULT_DEMO_DAYS,
    end_date: date | None = None,
) -> list[dict]:
    if event_count <= 0:
        raise ValueError("event_count must be positive.")
    if batch_size <= 0:
        raise ValueError("batch_size must be positive.")
    if span_days < 30:
        raise ValueError("span_days must be at least 30 days for meaningful demo data.")

    rng = Random(seed)
    last_day = end_date or datetime.now(timezone.utc).date()
    first_day = last_day - timedelta(days=span_days - 1)
    daily_plan = _build_daily_plan(first_day, span_days, event_count)

    events: list[dict] = []
    running_index = 0
    for day_index, (current_day, day_event_count) in enumerate(daily_plan):
        for event_offset in range(day_event_count):
            running_index += 1
            events.append(_build_event(rng, current_day, day_index, running_index, event_offset))

    events.sort(key=lambda item: item["timestamp"])

    envelopes: list[dict] = []
    for batch_index, batch_start in enumerate(range(0, len(events), batch_size), start=1):
        batch_events = events[batch_start : batch_start + batch_size]
        envelopes.append(_build_envelope(batch_events, batch_index))
    return envelopes


def summarize_demo_envelopes(envelopes: Iterable[dict]) -> dict[str, object]:
    events = [event for envelope in envelopes for event in envelope["events"]]
    timestamps = [event["timestamp"] for event in events]
    source_ips = {event["sourceIp"] for event in events}
    workspace_names = {event["workspaceName"] for event in events}
    languages = {event["language"] for event in events}
    source_types = {event["sourceType"] for event in events}
    ide_values = {event["ide"] for event in events}

    return {
        "eventCount": len(events),
        "sourceIpCount": len(source_ips),
        "projectCount": len(workspace_names),
        "languageCount": len(languages),
        "sourceTypeCount": len(source_types),
        "ideCount": len(ide_values),
        "fromTimestamp": min(timestamps) if timestamps else None,
        "toTimestamp": max(timestamps) if timestamps else None,
    }


def _build_daily_plan(first_day: date, span_days: int, event_count: int) -> list[tuple[date, int]]:
    weighted_days: list[tuple[date, float]] = []
    for day_offset in range(span_days):
        current_day = first_day + timedelta(days=day_offset)
        progress = day_offset / max(span_days - 1, 1)
        growth_factor = 0.65 + progress * 2.5
        weekday_factor = 1.25 if current_day.weekday() < 5 else 0.55
        sprint_factor = 1.0 + 0.22 * math.sin(day_offset / 6.0)
        month_end_factor = 1.35 if current_day.day in {25, 26, 27, 28} else 1.0
        anomaly_factor = 2.15 if day_offset in ANOMALY_DAY_OFFSETS else 1.0
        weighted_days.append((current_day, growth_factor * weekday_factor * sprint_factor * month_end_factor * anomaly_factor))

    total_weight = sum(weight for _, weight in weighted_days)
    raw_allocations = [(current_day, weight * event_count / total_weight) for current_day, weight in weighted_days]
    integer_allocations = [(current_day, int(value)) for current_day, value in raw_allocations]
    remainder = event_count - sum(value for _, value in integer_allocations)

    remainders = sorted(
        ((value - int(value), current_day) for current_day, value in raw_allocations),
        reverse=True,
    )
    allocation_map = {current_day: count for current_day, count in integer_allocations}
    for _, current_day in remainders[:remainder]:
        allocation_map[current_day] += 1

    return [(current_day, allocation_map[current_day]) for current_day, _ in weighted_days if allocation_map[current_day] > 0]


def _build_event(rng: Random, current_day: date, day_index: int, global_index: int, day_event_index: int) -> dict:
    source = _weighted_choice(rng, ((profile, profile.activity_weight) for profile in SOURCE_PROFILES))
    project = _choose_project_for_source(rng, source)
    language = _choose_language_for_project(rng, project)
    source_type = _choose_source_type(rng, language, day_index)
    ide = _weighted_choice(rng, source.ide_weights)
    occurred_at = _build_timestamp(rng, current_day, source_type, day_index)
    line_count = _build_line_count(rng, source_type, language, project.key, day_index, global_index)
    relative_path = _build_relative_path(rng, project, language, source_type, global_index)
    code_snippet = _build_code_snippet(language, source_type, project.key, line_count, global_index)

    return {
        "eventId": f"demo-{current_day.strftime('%Y%m%d')}-{global_index:04d}",
        "timestamp": _to_timestamp_ms(occurred_at),
        "sourceType": source_type,
        "ide": ide,
        "userId": source.key,
        "userName": source.user_name,
        "userEmail": source.user_email,
        "organizationId": source.organization_id,
        "organizationName": source.organization_name,
        "sourceIp": source.source_ip,
        "workspaceName": project.workspace_name,
        "workspacePath": project.workspace_path,
        "projectKey": project.key,
        "filePath": f"{project.workspace_path}/{relative_path}",
        "relativePath": relative_path,
        "language": language,
        "gitRemoteUrl": project.git_remote_url,
        "gitBranch": _choose_branch(rng, project, day_index),
        "lineStart": 1 + (day_event_index % 24),
        "lineEnd": 1 + (day_event_index % 24) + line_count - 1,
        "lineCount": line_count,
        "codeSnippet": code_snippet,
        "taskId": f"task-{project.key}-{current_day.strftime('%Y%m')}-{1 + (global_index % 17):02d}",
    }


def _build_envelope(events: list[dict], batch_index: int) -> dict:
    from_timestamp = min(event["timestamp"] for event in events)
    to_timestamp = max(event["timestamp"] for event in events)
    ide_values = sorted({event["ide"] for event in events})
    return {
        "version": "v1",
        "source": "kilocode-ai-code-stats-demo",
        "mode": "historical-backfill" if batch_index == 1 else "incremental",
        "client": {
            "ide": "mixed" if len(ide_values) > 1 else ide_values[0],
            "wrapperName": "Kilo Code Demo Seeder",
            "wrapperVersion": "1.0.0",
            "extensionVersion": "1.0.0",
            "machineId": f"demo-batch-{batch_index:02d}",
        },
        "window": {
            "fromTimestamp": from_timestamp,
            "toTimestamp": to_timestamp,
            "timezone": "UTC",
            "generatedAt": _to_timestamp_ms(datetime.now(timezone.utc)),
        },
        "events": events,
    }


def _choose_project_for_source(rng: Random, source: SourceProfile) -> ProjectProfile:
    weights = {project_key: weight for project_key, weight in source.project_weights}
    candidates: list[tuple[ProjectProfile, float]] = []
    for project in PROJECTS:
        candidates.append((project, weights.get(project.key, 0.35)))
    return _weighted_choice(rng, candidates)


def _choose_language_for_project(rng: Random, project: ProjectProfile) -> str:
    return _weighted_choice(rng, project.language_weights)


def _choose_source_type(rng: Random, language: str, day_index: int) -> str:
    adjusted_weights: list[tuple[str, float]] = []
    for source_type, base_weight in SOURCE_TYPES:
        weight = base_weight
        if language in {"yaml", "sql"} and source_type in {"config_update", "bulk_apply"}:
            weight *= 1.8
        if language in {"java", "kotlin", "go"} and source_type == "agent_refactor":
            weight *= 1.35
        if language in {"typescript", "python"} and source_type == "agent_insert":
            weight *= 1.2
        if day_index in ANOMALY_DAY_OFFSETS and source_type in {"bulk_apply", "agent_refactor"}:
            weight *= 1.7
        adjusted_weights.append((source_type, weight))
    return _weighted_choice(rng, adjusted_weights)


def _build_timestamp(rng: Random, current_day: date, source_type: str, day_index: int) -> datetime:
    hour_weights = [
        (8, 0.5),
        (9, 1.2),
        (10, 1.15),
        (11, 1.0),
        (13, 0.7),
        (14, 1.1),
        (15, 1.25),
        (16, 1.05),
        (19, 0.9),
        (20, 1.15),
        (21, 1.05),
        (22, 0.75),
    ]
    if source_type == "bulk_apply":
        hour_weights.extend(((17, 0.8), (23, 0.9)))
    if day_index in ANOMALY_DAY_OFFSETS:
        hour_weights.extend(((18, 1.4), (21, 1.6), (23, 1.3)))

    selected_hour = _weighted_choice(rng, hour_weights)
    minute = rng.randint(0, 59)
    second = rng.randint(0, 59)
    return datetime.combine(current_day, time(selected_hour, minute, second), tzinfo=timezone.utc)


def _build_line_count(
    rng: Random,
    source_type: str,
    language: str,
    project_key: str,
    day_index: int,
    global_index: int,
) -> int:
    ranges = {
        "agent_insert": (12, 44),
        "agent_refactor": (18, 76),
        "bulk_apply": (36, 128),
        "test_fix": (6, 24),
        "config_update": (8, 22),
    }
    lower, upper = ranges[source_type]

    if language in {"yaml", "sql"}:
        lower = max(6, lower - 4)
        upper = max(lower + 8, upper - 18)
    if language in {"java", "kotlin", "go"}:
        upper += 12
    if project_key in {"phoenix-trade", "atlas-data", "nebula-risk"} and source_type in {"agent_refactor", "bulk_apply"}:
        upper += 24
    if day_index in ANOMALY_DAY_OFFSETS:
        upper += 40
    if global_index in MEGA_EVENT_OFFSETS:
        return min(240, upper + 90)
    return rng.randint(lower, upper)


def _build_relative_path(
    rng: Random,
    project: ProjectProfile,
    language: str,
    source_type: str,
    global_index: int,
) -> str:
    profile = LANGUAGES[language]
    section = profile.directories[global_index % len(profile.directories)]
    module = project.key.replace("-", "_")
    suffix = f"{(global_index % 97) + 1:02d}"

    if language == "typescript":
        base_name = "view-model" if source_type == "config_update" else ("service" if source_type == "agent_refactor" else "handler")
        return f"{section}/{module}/{base_name}-{suffix}.{profile.extension}"
    if language == "python":
        base_name = "job" if source_type == "bulk_apply" else ("processor" if source_type == "agent_refactor" else "service")
        return f"{section}/{module}/{base_name}_{suffix}.{profile.extension}"
    if language == "go":
        base_name = "router" if source_type == "config_update" else ("syncer" if source_type == "bulk_apply" else "service")
        return f"{section}/{module}/{base_name}_{suffix}.{profile.extension}"
    if language == "java":
        class_name = f"{project.key.title().replace('-', '')}{suffix}Flow"
        return f"{section}/com/demo/{module}/{class_name}.{profile.extension}"
    if language == "kotlin":
        class_name = f"{project.key.title().replace('-', '')}{suffix}Coordinator"
        return f"{section}/com/demo/{module}/{class_name}.{profile.extension}"
    if language == "sql":
        base_name = "backfill" if source_type == "bulk_apply" else "refresh"
        return f"{section}/{datetime.now(timezone.utc).strftime('%Y%m')}_{module}_{base_name}_{suffix}.{profile.extension}"
    if language == "yaml":
        base_name = "deployment" if source_type == "config_update" else "pipeline"
        env_name = ("prod" if rng.random() > 0.45 else "staging")
        return f"{section}/{module}/{env_name}-{base_name}-{suffix}.{profile.extension}"
    base_name = "worker" if source_type == "bulk_apply" else "adapter"
    return f"{section}/{module}/{base_name}_{suffix}.{profile.extension}"


def _build_code_snippet(language: str, source_type: str, project_key: str, line_count: int, global_index: int) -> str:
    module = project_key.replace("-", "_")
    if language == "typescript":
        return _build_block_snippet(
            prefix=[
                f"export const build{global_index % 41:02d}{module.title().replace('_', '')} = (payload: Record<string, unknown>) => {{",
                "  const result: Record<string, unknown> = {}",
            ],
            body_template='  result["{module}_{n:02d}"] = payload["{module}_{n:02d}"] ?? "{module}-{n:02d}"',
            footer=[
                "  return result",
                "}",
            ],
            line_count=line_count,
            module=module,
        )
    if language == "python":
        return _build_block_snippet(
            prefix=[
                f"def build_{module}_{global_index % 37:02d}(payload: dict[str, object]) -> dict[str, object]:",
                "    result: dict[str, object] = {}",
            ],
            body_template='    result["{module}_{n:02d}"] = payload.get("{module}_{n:02d}", "{module}-{n:02d}")',
            footer=[
                "    return result",
            ],
            line_count=line_count,
            module=module,
        )
    if language == "go":
        return _build_block_snippet(
            prefix=[
                f"func Build{global_index % 53:02d}{module.title().replace('_', '')}(payload map[string]any) map[string]any {{",
                "    result := map[string]any{}",
            ],
            body_template='    result["{module}_{n:02d}"] = pick(payload, "{module}_{n:02d}", "{module}-{n:02d}")',
            footer=[
                "    return result",
                "}",
            ],
            line_count=line_count,
            module=module,
        )
    if language == "java":
        return _build_block_snippet(
            prefix=[
                f"public Map<String, Object> build{global_index % 47:02d}{module.title().replace('_', '')}(Map<String, Object> payload) {{",
                "    Map<String, Object> result = new LinkedHashMap<>();",
            ],
            body_template='    result.put("{module}_{n:02d}", payload.getOrDefault("{module}_{n:02d}", "{module}-{n:02d}"));',
            footer=[
                "    return result;",
                "}",
            ],
            line_count=line_count,
            module=module,
        )
    if language == "kotlin":
        return _build_block_snippet(
            prefix=[
                f"fun build{global_index % 43:02d}{module.title().replace('_', '')}(payload: Map<String, Any?>): MutableMap<String, Any?> {{",
                "    val result = linkedMapOf<String, Any?>()",
            ],
            body_template='    result["{module}_{n:02d}"] = payload["{module}_{n:02d}"] ?: "{module}-{n:02d}"',
            footer=[
                "    return result",
                "}",
            ],
            line_count=line_count,
            module=module,
        )
    if language == "sql":
        return _build_sql_snippet(module, line_count)
    if language == "yaml":
        return _build_yaml_snippet(module, source_type, line_count)
    return _build_block_snippet(
        prefix=[
            f"pub fn build_{module}_{global_index % 39:02d}(payload: &HashMap<String, String>) -> HashMap<String, String> {{",
            "    let mut result = HashMap::new();",
        ],
        body_template='    result.insert("{module}_{n:02d}".into(), payload.get("{module}_{n:02d}").cloned().unwrap_or_else(|| "{module}-{n:02d}".into()));',
        footer=[
            "    result",
            "}",
        ],
        line_count=line_count,
        module=module,
    )


def _build_block_snippet(prefix: list[str], body_template: str, footer: list[str], line_count: int, module: str) -> str:
    body_count = max(line_count - len(prefix) - len(footer), 0)
    body = [body_template.format(module=module, n=index + 1) for index in range(body_count)]
    lines = prefix + body + footer
    return "\n".join(lines[:line_count])


def _build_sql_snippet(module: str, line_count: int) -> str:
    prefix = [
        f"WITH staged_{module} AS (",
        "    SELECT batch_id, field_key, field_value",
        "    FROM staging_changes",
        ")",
        f"UPDATE analytics_{module}",
        "SET last_value = staged.field_value",
        f"FROM staged_{module} AS staged",
    ]
    body_count = max(line_count - len(prefix) - 1, 0)
    body = [
        f"WHERE staged.field_key = '{module}_{index + 1:02d}' AND analytics_{module}.dimension_key = '{module}_{index + 1:02d}'"
        for index in range(body_count)
    ]
    return "\n".join((prefix + body + [";"])[:line_count])


def _build_yaml_snippet(module: str, source_type: str, line_count: int) -> str:
    prefix = [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        f"  name: {module.replace('_', '-')}",
        "spec:",
        "  template:",
        "    spec:",
        "      containers:",
        f"        - name: {module.replace('_', '-')}",
        "          env:",
    ]
    body_count = max(line_count - len(prefix), 0)
    if source_type == "config_update":
        body = [
            f'            - name: FEATURE_FLAG_{index + 1:02d}\n              value: "enabled-{index + 1:02d}"'
            for index in range((body_count + 1) // 2)
        ]
        lines = prefix + [line for block in body for line in block.splitlines()]
        return "\n".join(lines[:line_count])

    body = [f"            - name: PIPELINE_STEP_{index + 1:02d}" for index in range(body_count)]
    return "\n".join((prefix + body)[:line_count])


def _choose_branch(rng: Random, project: ProjectProfile, day_index: int) -> str:
    if day_index in ANOMALY_DAY_OFFSETS and len(project.branches) > 1:
        return project.branches[-1]
    if day_index % 21 == 0 and len(project.branches) > 1:
        return project.branches[1]
    return project.branches[0]


def _weighted_choice[T](rng: Random, choices: Iterable[tuple[T, float]]) -> T:
    materialized = [(item, weight) for item, weight in choices if weight > 0]
    if not materialized:
        raise ValueError("weighted choice requires at least one positive weight")

    total = sum(weight for _, weight in materialized)
    cursor = rng.uniform(0, total)
    rolling = 0.0
    for item, weight in materialized:
        rolling += weight
        if cursor <= rolling:
            return item
    return materialized[-1][0]


def _to_timestamp_ms(value: datetime) -> int:
    return int(value.timestamp() * 1000)
