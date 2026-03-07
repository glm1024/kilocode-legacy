from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib import error, request

# Make direct script execution resolve the local `app` package before any global module named `app`.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.demo_data import (
    DEFAULT_DEMO_BATCH_SIZE,
    DEFAULT_DEMO_DAYS,
    DEFAULT_DEMO_EVENT_COUNT,
    DEFAULT_DEMO_SEED,
    generate_demo_envelopes,
    summarize_demo_envelopes,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate and optionally ingest rich demo AI code insights data."
    )
    parser.add_argument("--api-base-url", default="http://127.0.0.1:18080", help="API base URL.")
    parser.add_argument("--events", type=int, default=DEFAULT_DEMO_EVENT_COUNT, help="Total event count.")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_DEMO_BATCH_SIZE, help="Envelope batch size.")
    parser.add_argument("--span-days", type=int, default=DEFAULT_DEMO_DAYS, help="How many days the demo data spans.")
    parser.add_argument("--seed", type=int, default=DEFAULT_DEMO_SEED, help="Deterministic random seed.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Optional directory to write generated envelopes as JSON files before posting.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only generate data and print summary without posting to the API.",
    )
    args = parser.parse_args()

    envelopes = generate_demo_envelopes(
        event_count=args.events,
        batch_size=args.batch_size,
        seed=args.seed,
        span_days=args.span_days,
    )
    summary = summarize_demo_envelopes(envelopes)
    print(json.dumps(summary, indent=2))

    if args.output_dir:
        _write_envelopes(args.output_dir, envelopes)
        print(f"Wrote {len(envelopes)} envelope files into {args.output_dir}")

    if args.dry_run:
        return 0

    ingest_url = args.api_base_url.rstrip("/") + "/api/v1/ingest/ai-code-stats"
    inserted_total = 0
    duplicate_total = 0
    for index, envelope in enumerate(envelopes, start=1):
        result = _post_json(ingest_url, envelope)
        inserted_total += int(result.get("insertedEvents", 0))
        duplicate_total += int(result.get("duplicateEvents", 0))
        print(
            f"[{index}/{len(envelopes)}] kind={result.get('kind')} "
            f"inserted={result.get('insertedEvents', 0)} duplicate={result.get('duplicateEvents', 0)}"
        )

    print(
        json.dumps(
            {
                "postedEnvelopes": len(envelopes),
                "requestedEvents": args.events,
                "insertedEvents": inserted_total,
                "duplicateEvents": duplicate_total,
                "apiBaseUrl": args.api_base_url,
            },
            indent=2,
        )
    )
    return 0


def _write_envelopes(output_dir: Path, envelopes: list[dict]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for index, envelope in enumerate(envelopes, start=1):
        payload_path = output_dir / f"demo-envelope-{index:02d}.json"
        payload_path.write_text(json.dumps(envelope, indent=2), encoding="utf-8")


def _post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:  # pragma: no cover - manual CLI surface
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code} when posting demo data: {detail}") from exc
    except error.URLError as exc:  # pragma: no cover - manual CLI surface
        raise SystemExit(f"Could not reach API at {url}: {exc.reason}") from exc


if __name__ == "__main__":
    raise SystemExit(main())
