#!/usr/bin/env python3
"""Add LearnHarness progress to Hanson's existing read-only Dot connector."""

import importlib
import json
from pathlib import Path
import sys
from typing import Any
from urllib.request import urlopen

import anyio
from mcp.types import ToolAnnotations

PROGRESS_URL = "http://127.0.0.1:8787/api/study-progress"


def read_progress():
    with urlopen(PROGRESS_URL, timeout=5) as response:
        return json.load(response)


def add_study_tool(mcp):
    # Advertise invocation conditions as well as the schema, so Dot can use
    # this tool during its own check-ins without asking Hanson for a total.
    @mcp.tool(annotations=ToolAnnotations(
        title="Check LearnHarness study time and progress",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    ))
    async def learnharness_progress() -> dict[str, Any]:
        """Call when checking how much Hanson studied or what he completed in LearnHarness, including proactive check-ins. Returns active study seconds, questions answered and practice problems concluded for today, this week (Monday to date), and all time in America/New_York. Label historicalEstimateSeconds separately as an older transcript-based estimate. A null trackingStartedAt means live study time has not been recorded yet."""
        try:
            return await anyio.to_thread.run_sync(read_progress)
        except (OSError, ValueError):
            return {"status": "unavailable", "message": "LearnHarness could not provide study progress. Retry when its host is online."}


def main():
    existing_entry = Path(sys.argv.pop(1)).resolve()
    sys.path.insert(0, str(existing_entry.parent))
    connector = importlib.import_module(existing_entry.stem)
    original_factory = connector.make_workouts_server

    def extended_factory(store):
        mcp = original_factory(store)
        add_study_tool(mcp)
        return mcp

    connector.make_workouts_server = extended_factory
    connector.main()


if __name__ == "__main__":
    main()
