"""Schema-only payload capture for synthetic, secret-free fixtures."""

from __future__ import annotations

import json
import re
from typing import Any

from .contract import MAX_INPUT_BYTES

_SENSITIVE = (
    "authorization",
    "cookie",
    "credential",
    "key",
    "password",
    "secret",
    "token",
)
_ENUM_FIELDS = frozenset(
    {
        "event",
        "hookEventName",
        "hook_event_name",
        "reason",
        "tool",
        "toolName",
        "tool_name",
    }
)
_SAFE_ENUM = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_TOKEN_PREFIX = re.compile(
    r"(?i)(?:bearer\s+|gh[oprsu]_|github_pat_|sk-(?:proj-)?|xox[baprs]-)"
)
_JWT = re.compile(
    r"^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$"
)


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "unknown"


def _looks_secret(value: str) -> bool:
    stripped = value.strip()
    if _TOKEN_PREFIX.search(stripped) or _JWT.fullmatch(stripped):
        return True
    if len(stripped) > 64:
        return True
    if len(stripped) < 32 or any(character.isspace() for character in stripped):
        return False
    classes = sum(
        (
            any(character.islower() for character in stripped),
            any(character.isupper() for character in stripped),
            any(character.isdigit() for character in stripped),
            any(not character.isalnum() for character in stripped),
        )
    )
    return classes >= 3


def _sensitive_key(value: str) -> bool:
    lowered = value.lower()
    return any(marker in lowered for marker in _SENSITIVE) or _looks_secret(value)


def _shape(value: Any, *, key: str = "", depth: int = 0) -> Any:
    if depth > 8:
        return "<redacted:depth>"
    lowered = key.lower()
    if _sensitive_key(key):
        return f"<redacted:{_type_name(value)}>"
    if isinstance(value, dict):
        shaped: dict[str, Any] = {}
        redacted_index = 0
        for child_key, child_value in list(value.items())[:200]:
            normalized_key = str(child_key)
            if _sensitive_key(normalized_key):
                redacted_index += 1
                shaped[f"<redacted:key:{redacted_index}>"] = (
                    f"<redacted:{_type_name(child_value)}>"
                )
                continue
            shaped[normalized_key[:120]] = _shape(
                child_value,
                key=normalized_key,
                depth=depth + 1,
            )
        return shaped
    if isinstance(value, list):
        return [
            _shape(item, key=key, depth=depth + 1)
            for item in value[:100]
        ]
    if isinstance(value, str):
        if _looks_secret(value):
            return "<redacted:string>"
        if key in _ENUM_FIELDS and _SAFE_ENUM.fullmatch(value):
            return value
        if "path" in lowered or key in {"cwd", "file"}:
            return "<synthetic:path>"
        if lowered.endswith("id") or lowered.endswith("_id"):
            return "<synthetic:id>"
        return "<synthetic:string>"
    if isinstance(value, bool | int | float) or value is None:
        return value
    return f"<redacted:{_type_name(value)}>"


def capture_schema_fixture(
    payload: bytes | dict[str, Any],
    *,
    runtime_id: str,
) -> dict[str, Any]:
    if isinstance(payload, bytes):
        if len(payload) > MAX_INPUT_BYTES:
            return {
                "schema_version": 1,
                "status": "invalid",
                "reason_code": "contract_input_too_large",
            }
        try:
            decoded = payload.decode("utf-8", errors="strict")
            value = json.loads(decoded)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {
                "schema_version": 1,
                "status": "invalid",
                "reason_code": "contract_json_invalid",
            }
    else:
        value = payload
    if not isinstance(value, dict):
        return {
            "schema_version": 1,
            "status": "invalid",
            "reason_code": "contract_json_invalid",
        }
    return {
        "schema_version": 1,
        "status": "captured",
        "runtime_id": runtime_id,
        "shape": _shape(value),
    }
