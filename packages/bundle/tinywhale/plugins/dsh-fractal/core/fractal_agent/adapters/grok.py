"""Grok camelCase hook normalizer."""

from __future__ import annotations

from typing import Any

from .common import actionable_file, change_event, closeout_event


def normalize(payload: dict[str, Any]) -> list[dict[str, Any]]:
    event = payload.get("hookEventName")
    if event in {"post_tool_use", "post_tool_use_failure", "PostToolUse"}:
        tool_input = payload.get("toolInput")
        file = actionable_file(payload.get("toolName"), tool_input)
        if file is None:
            return []
        if event == "post_tool_use":
            success: bool | None = True
        elif event == "post_tool_use_failure":
            success = False
        else:
            result = payload.get("toolResult")
            legacy_success = (
                result.get("success") if isinstance(result, dict) else None
            )
            success = legacy_success if isinstance(legacy_success, bool) else None
        return change_event(
            session=payload.get("sessionId"),
            cwd=payload.get("cwd"),
            file=file,
            success=success,
        )
    if event in {"stop", "Stop"} and payload.get("reason") == "end_turn":
        return closeout_event(
            session=payload.get("sessionId"),
            cwd=payload.get("cwd"),
            reason="turn_complete",
        )
    return []
