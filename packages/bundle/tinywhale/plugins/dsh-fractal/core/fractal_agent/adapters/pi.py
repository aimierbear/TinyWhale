"""Pi extension event normalizer."""

from __future__ import annotations

from typing import Any

from .common import AdapterError, actionable_file, change_event, closeout_event


def _identity(payload: dict[str, Any]) -> tuple[Any, Any]:
    host = payload.get("host")
    if isinstance(host, dict):
        return (
            payload.get("session_id", host.get("session_id")),
            payload.get("cwd", host.get("cwd")),
        )
    return payload.get("session_id"), payload.get("cwd")


def normalize(payload: dict[str, Any]) -> list[dict[str, Any]]:
    event = payload.get("type")
    if event == "tool_result":
        for field in ("toolCallId", "toolName"):
            if not isinstance(payload.get(field), str) or not payload[field]:
                raise AdapterError("adapter_field_invalid", field)
        if not isinstance(payload.get("isError"), bool):
            raise AdapterError("adapter_field_invalid", "isError")
        session, cwd = _identity(payload)
        tool_input = payload.get("input")
        file = actionable_file(payload.get("toolName"), tool_input)
        if file is None:
            return []
        return change_event(
            session=session,
            cwd=cwd,
            file=file,
            success=not payload["isError"],
        )
    if event == "agent_settled":
        session, cwd = _identity(payload)
        return closeout_event(
            session=session,
            cwd=cwd,
            reason="agent_settled",
        )

    legacy_event = payload.get("event")
    if legacy_event == "tool_execution_end":
        file = actionable_file(payload.get("tool"), payload.get("input"))
        if file is None:
            return []
        is_error = payload.get("is_error")
        success = None if not isinstance(is_error, bool) else not is_error
        return change_event(
            session=payload.get("session_id"),
            cwd=payload.get("cwd"),
            file=file,
            success=success,
        )
    if legacy_event in {"agent_end", "session_end"}:
        return closeout_event(
            session=payload.get("session_id"),
            cwd=payload.get("cwd"),
            reason="agent_settled" if legacy_event == "agent_end" else "session_end",
        )
    return []
