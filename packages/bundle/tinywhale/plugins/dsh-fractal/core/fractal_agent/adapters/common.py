"""Vendor-neutral normalized event helpers."""

from __future__ import annotations

import hashlib
from typing import Any, Mapping

if "_FRACTAL_ADAPTER_ERROR_TYPE" in globals():
    AdapterError = globals()["_FRACTAL_ADAPTER_ERROR_TYPE"]
else:
    from fractal_agent.contract import AdapterError


def hashed_session(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise AdapterError("adapter_identity_missing", "session")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def find_file(value: Mapping[str, Any]) -> str | None:
    for key in ("file", "file_path", "path", "target_file"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def is_modifying_tool(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    normalized = value.lower().replace("-", "_")
    return any(
        marker in normalized
        for marker in (
            "apply_patch",
            "create",
            "delete",
            "edit",
            "move",
            "patch",
            "rename",
            "replace",
            "write",
        )
    )


def actionable_file(tool: Any, value: Any) -> str | None:
    file = find_file(value) if isinstance(value, Mapping) else None
    if file is None and is_modifying_tool(tool):
        raise AdapterError("adapter_file_missing", "file")
    return file


def _require_cwd(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise AdapterError("adapter_identity_missing", "cwd")
    return value


def change_event(
    *,
    session: Any,
    cwd: Any,
    file: Any,
    success: bool | None,
    evidence_type: str = "native_success",
) -> list[dict[str, Any]]:
    session_id = hashed_session(session)
    normalized_cwd = _require_cwd(cwd)
    if not isinstance(file, str) or not file:
        raise AdapterError("adapter_file_missing", "file")
    outcome = "unknown" if success is None else ("success" if success else "failed")
    return [
        {
            "action": "record_observed_change",
            "session_id": session_id,
            "requires": ["scope_id"],
            "fields": {
                "cwd": normalized_cwd,
                "file": file,
                "evidence_type": evidence_type,
                "tool_outcome": outcome,
            },
        }
    ]


def closeout_event(*, session: Any, cwd: Any, reason: str) -> list[dict[str, Any]]:
    session_id = hashed_session(session)
    normalized_cwd = _require_cwd(cwd)
    return [
        {
            "action": "closeout_status",
            "session_id": session_id,
            "requires": ["scope_id"],
            "fields": {"cwd": normalized_cwd, "completion_reason": reason},
        }
    ]
