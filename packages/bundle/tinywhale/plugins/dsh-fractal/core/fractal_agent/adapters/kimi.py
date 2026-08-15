"""Kimi hook normalizer for its Claude-like, not identical, payload."""

from __future__ import annotations

import json
from typing import Any, Mapping

from .claude import normalize as normalize_claude


def normalize(payload: dict[str, Any]) -> list[dict[str, Any]]:
    value = dict(payload)
    if (
        value.get("hook_event_name") == "PostToolUse"
        and not isinstance(value.get("tool_response"), Mapping)
        and "tool_output" in value
    ):
        output = value.get("tool_output")
        decoded: Any = None
        if isinstance(output, str):
            try:
                decoded = json.loads(output)
            except json.JSONDecodeError:
                decoded = None
        elif isinstance(output, Mapping):
            decoded = output
        response = dict(decoded) if isinstance(decoded, Mapping) else {}
        response.setdefault("success", True)
        value["tool_response"] = response
    return normalize_claude(value)

__all__ = ["normalize"]
