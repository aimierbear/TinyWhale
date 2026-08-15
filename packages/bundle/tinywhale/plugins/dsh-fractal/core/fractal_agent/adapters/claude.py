"""Claude Code snake_case hook normalizer."""

from __future__ import annotations

from typing import Any

from .common import change_event, closeout_event, find_file


def normalize(payload: dict[str, Any]) -> list[dict[str, Any]]:
    event = payload.get("hook_event_name")
    if event == "PostToolUse":
        tool_input = payload.get("tool_input")
        response = payload.get("tool_response")
        file = find_file(tool_input) if isinstance(tool_input, dict) else None
        success = response.get("success") if isinstance(response, dict) else None
        return change_event(
            session=payload.get("session_id"),
            cwd=payload.get("cwd"),
            file=file,
            success=success if isinstance(success, bool) else None,
        )
    if event == "Stop":
        return closeout_event(
            session=payload.get("session_id"),
            cwd=payload.get("cwd"),
            reason="turn_complete",
        )
    return []
