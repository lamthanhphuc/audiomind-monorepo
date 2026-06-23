#!/usr/bin/env python3
"""Wrapper for backfill_canonical.py (Epic 3 Slice 2)."""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

_AI_SERVICE_ROOT = Path(__file__).resolve().parents[1] / "demoRecordAUDIOMID" / "ai-service"
if str(_AI_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_AI_SERVICE_ROOT))

from app.scripts.backfill_canonical import backfill  # noqa: E402


def _process_meeting(
    meeting_id: int,
    *,
    rebuild_stats: bool,
    dry_run: bool,
    worker_id: int,
) -> int:
    result = backfill(
        meeting_id,
        rebuild_stats=rebuild_stats,
        dry_run=dry_run,
        worker_id=worker_id,
    )
    print(result)
    return 0 if result.status in {
        "updated",
        "noop_idempotent",
        "skipped_existing_newer",
        "dry_run",
    } else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill canonical transcript rows")
    parser.add_argument("--meeting-id", type=int, dest="meeting_id", required=True)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument(
        "--rebuild-stats",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    meeting_ids = [args.meeting_id]
    if args.batch_size < 1:
        parser.error("--batch-size must be >= 1")
    if args.concurrency < 1:
        parser.error("--concurrency must be >= 1")

    meeting_ids = meeting_ids[: args.batch_size]

    if args.dry_run:
        print(
            f"DRY RUN meeting_id={args.meeting_id} rebuild_stats={args.rebuild_stats} "
            f"batch_size={args.batch_size} concurrency={args.concurrency}"
        )

    if args.concurrency == 1:
        return _process_meeting(
            meeting_ids[0],
            rebuild_stats=args.rebuild_stats,
            dry_run=args.dry_run,
            worker_id=0,
        )

    exit_code = 0
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {
            pool.submit(
                _process_meeting,
                meeting_id,
                rebuild_stats=args.rebuild_stats,
                dry_run=args.dry_run,
                worker_id=index % args.concurrency,
            ): meeting_id
            for index, meeting_id in enumerate(meeting_ids)
        }
        for future in as_completed(futures):
            if future.result() != 0:
                exit_code = 1
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
