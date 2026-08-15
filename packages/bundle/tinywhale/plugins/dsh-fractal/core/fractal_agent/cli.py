"""Stable stdin/stdout boundary for fractal actions."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from .contract import (
    ACTION_NAMES,
    MAX_INPUT_BYTES,
    ContractError,
    error_result,
    validate_request,
)


def _emit(payload: dict[str, Any]) -> None:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()


def _read_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ContractError("contract_input_too_large", "input too large")
    try:
        decoded = raw.decode("utf-8", errors="strict")
        value = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("contract_json_invalid", "invalid JSON") from exc
    if not isinstance(value, dict):
        raise ContractError("contract_json_invalid", "request must be object")
    return value


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    action = args[0] if len(args) == 1 else ""
    operation_id = ""
    try:
        if action not in ACTION_NAMES:
            raise ContractError("contract_action_unknown", "unknown action")
        request = _read_request()
        if isinstance(request.get("operation_id"), str):
            operation_id = request["operation_id"]
        request = validate_request(action, request)

        from .actions import ActionService  # Imported after contract validation.

        state_root = Path(
            os.environ.get(
                "FRACTAL_STATE_ROOT",
                "~/.local/state/fractal-agent/v1",
            )
        ).expanduser()
        result = ActionService(state_root=state_root).dispatch(action, request)
        _emit(result)
        return 0
    except ContractError as exc:
        _emit(
            error_result(
                exc.reason_code,
                operation_id=operation_id,
                status="error" if exc.exit_code != 64 else "invalid",
                retryable=exc.retryable,
            )
        )
        if exc.exit_code != 64:
            sys.stderr.write(f"fractal-action:{exc.reason_code}\n")
        return exc.exit_code
    except Exception:
        _emit(
            error_result(
                "state_internal_error",
                operation_id=operation_id,
                status="error",
            )
        )
        sys.stderr.write("fractal-action:state_internal_error\n")
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
