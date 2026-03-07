from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from app.demo_data import generate_demo_envelopes, summarize_demo_envelopes


def test_generate_demo_envelopes_has_expected_shape_and_variety():
    envelopes = generate_demo_envelopes(event_count=1000, batch_size=125, seed=20260307, span_days=180)
    summary = summarize_demo_envelopes(envelopes)
    all_events = [event for envelope in envelopes for event in envelope["events"]]

    assert len(envelopes) == 8
    assert summary["eventCount"] == 1000
    assert summary["sourceIpCount"] >= 10
    assert summary["projectCount"] >= 8
    assert summary["languageCount"] >= 7
    assert summary["sourceTypeCount"] >= 5
    assert summary["ideCount"] >= 3

    timestamps = [event["timestamp"] for event in all_events]
    unique_event_ids = {event["eventId"] for event in all_events}
    unique_projects = {event["workspaceName"] for event in all_events}
    unique_languages = {event["language"] for event in all_events}

    assert len(unique_event_ids) == 1000
    assert len(unique_projects) >= 8
    assert len(unique_languages) >= 7
    assert max(timestamps) > min(timestamps)

    from_dt = datetime.fromtimestamp(min(timestamps) / 1000, tz=timezone.utc)
    to_dt = datetime.fromtimestamp(max(timestamps) / 1000, tz=timezone.utc)
    assert (to_dt.date() - from_dt.date()).days >= 150

    assert all(event["lineCount"] == len(event["codeSnippet"].splitlines()) for event in all_events)
    assert any(event["lineCount"] >= 150 for event in all_events)


def test_generate_demo_envelopes_respects_batch_size():
    envelopes = generate_demo_envelopes(event_count=230, batch_size=64, seed=7, span_days=90)

    sizes = [len(envelope["events"]) for envelope in envelopes]

    assert sizes == [64, 64, 64, 38]
    assert sum(sizes) == 230


def test_seed_demo_data_script_supports_direct_execution(tmp_path):
    project_root = Path(__file__).resolve().parents[1]
    output_dir = tmp_path / "demo-output"

    result = subprocess.run(
        [
            sys.executable,
            "scripts/seed_demo_data.py",
            "--dry-run",
            "--output-dir",
            str(output_dir),
            "--events",
            "25",
            "--batch-size",
            "10",
        ],
        cwd=project_root,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "eventCount" in result.stdout
    assert output_dir.exists()
    assert len(list(output_dir.glob("demo-envelope-*.json"))) == 3
