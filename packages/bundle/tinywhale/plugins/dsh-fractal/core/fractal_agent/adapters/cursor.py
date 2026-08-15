"""Cursor native hook and conservative manual fallback normalizer."""

from __future__ import annotations

from typing import Any

import json

from .common import actionable_file, change_event, closeout_event


def normalize(payload: dict[str, Any]) -> list[dict[str, Any]]:
    event = payload.get("_fractal_event", payload.get("event"))
    if event in {"PostToolUse", "PostToolUseFailure", "postToolUse", "postToolUseFailure"}:
        tool_input = payload.get("tool_input")
        file = actionable_file(payload.get("tool_name"), tool_input)
        if file is None:
            return []
        if event in {"PostToolUseFailure", "postToolUseFailure"}:
            success: bool | None = False
        else:
            output = payload.get("tool_output")
            if isinstance(output, str):
                try:
                    output = json.loads(output)
                except json.JSONDecodeError:
                    output = None
            candidate = (
                output.get("success")
                if isinstance(output, dict)
                else None
            )
            success = candidate if isinstance(candidate, bool) else True
        return change_event(
            session=payload.get("session_id"),
            cwd=payload.get("cwd"),
            file=file,
            success=success,
        )
    if event in {"Stop", "stop"}:
        return closeout_event(
            session=payload.get("session_id"),
            cwd=payload.get("cwd"),
            reason="turn_complete",
        )
    if event == "manual_check":
        return change_event(
            session=payload.get("session_id"),
            cwd=payload.get("cwd"),
            file=payload.get("file"),
            success=None,
            evidence_type="observed_final_diff",
        )
    if event == "manual_closeout":
        return closeout_event(
            session=payload.get("session_id"),
            cwd=payload.get("cwd"),
            reason="manual_check",
        )
    return []
