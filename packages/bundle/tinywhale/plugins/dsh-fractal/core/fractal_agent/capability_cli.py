"""Narrow local capabilities shared by host adapters and plugins."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping

from .actions import ActionService
from .contract import MAX_INPUT_BYTES, ContractError
from .document import (
    apply_semantic_document,
    apply_semantic_document_for_closeout,
    document_review_evidence,
    document_reviews_satisfied,
)
from .evidence import (
    build_sync_receipt,
    evidence_matches_files,
    project_evidence,
)
from .graph import GraphReconciler
from .paths import PathBoundaryError, discover_project_root
from .util import sha256_json, utc_now

CAPABILITY_OPERATIONS = frozenset(
    {
        "scan_dependencies",
        "query_dependencies",
        "update_fractal_document",
        "complete_closeout",
    }
)


def _emit(payload: Mapping[str, Any]) -> None:
    sys.stdout.write(
        json.dumps(
            dict(payload),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    )
    sys.stdout.flush()


def _read_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ContractError("contract_input_too_large", "input too large")
    try:
        value = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("contract_json_invalid", "invalid JSON") from exc
    if not isinstance(value, dict):
        raise ContractError("contract_json_invalid", "request must be object")
    return value


def _validate_fields(
    request: Mapping[str, Any],
    *,
    required: frozenset[str],
    optional: frozenset[str] = frozenset(),
) -> None:
    fields = set(request)
    if not required <= fields:
        raise ContractError("contract_field_missing", "required field missing")
    if fields - required - optional:
        raise ContractError("contract_field_unknown", "unknown field")


def _string(request: Mapping[str, Any], field: str, *, limit: int = 4096) -> str:
    value = request.get(field)
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ContractError("contract_field_invalid", "invalid string field")
    return value


def _state_root() -> Path:
    return Path(
        os.environ.get("FRACTAL_STATE_ROOT", "~/.local/state/fractal-agent/v1")
    ).expanduser()


def _scan(request: Mapping[str, Any]) -> dict[str, Any]:
    _validate_fields(
        request,
        required=frozenset({"project"}),
        optional=frozenset({"force_full"}),
    )
    force_full = request.get("force_full", False)
    if not isinstance(force_full, bool):
        raise ContractError("contract_field_invalid", "invalid force_full")
    root = discover_project_root(_string(request, "project"))
    return GraphReconciler(state_root=_state_root()).scan(
        root,
        force_full=force_full,
    )


def _query(request: Mapping[str, Any]) -> dict[str, Any]:
    _validate_fields(
        request,
        required=frozenset({"project", "file_path"}),
        optional=frozenset({"depth"}),
    )
    depth = request.get("depth", 1)
    if isinstance(depth, bool) or not isinstance(depth, int) or not 1 <= depth <= 4:
        raise ContractError("contract_field_invalid", "invalid graph depth")
    root = discover_project_root(_string(request, "project"))
    return GraphReconciler(state_root=_state_root()).query(
        root,
        _string(request, "file_path"),
        depth=depth,
    )


def _update(request: Mapping[str, Any]) -> dict[str, Any]:
    content = request.get("content")
    if not isinstance(content, str):
        raise ContractError("contract_field_invalid", "invalid document content")
    store = ActionService(state_root=_state_root()).store
    if "candidate_token" in request:
        _validate_fields(
            request,
            required=frozenset({"candidate_token", "content"}),
        )
        return apply_semantic_document(
            store,
            candidate_token=_string(request, "candidate_token", limit=4096),
            content=content,
        )
    _validate_fields(
        request,
        required=frozenset(
            {"closeout_request_id", "file_path", "content"}
        ),
    )
    return apply_semantic_document_for_closeout(
        store,
        closeout_request_id=_string(
            request,
            "closeout_request_id",
            limit=96,
        ),
        file_path=_string(request, "file_path", limit=4096),
        content=content,
    )


def _complete(request: Mapping[str, Any]) -> dict[str, Any]:
    _validate_fields(
        request,
        required=frozenset({"closeout_request_id"}),
    )
    closeout_request_id = _string(request, "closeout_request_id", limit=96)
    service = ActionService(state_root=_state_root())
    context = service.store.trusted_closeout_context(closeout_request_id)
    if context is None:
        return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
    if context["status"] == "completed":
        return {"status": "duplicate", "reason_code": "event_duplicate"}
    if context["status"] != "live":
        return {"status": "stale", "reason_code": "state_watermark_stale"}
    document_evidence = document_review_evidence(service.store, context)
    if document_evidence is None or not document_reviews_satisfied(
        service.store,
        context,
    ):
        return {"status": "pending", "reason_code": "capability_fallback"}
    root = Path(context["root"]).resolve(strict=True)
    source_evidence = project_evidence(
        root,
        [item["path"] for item in context["files"]],
        include_derived=False,
    )
    if (
        source_evidence["hash"] != context["evidence_hash"]
        or not evidence_matches_files(context["files"], source_evidence)
    ):
        return {"status": "stale", "reason_code": "state_watermark_stale"}
    closeout = {
        "closeout_request_id": closeout_request_id,
        "changed_set_id": context["changed_set_id"],
        "watermark": int(context["watermark"]),
        "changed_files": context["files"],
    }
    receipt = build_sync_receipt(
        root,
        closeout,
        signer=service.store.receipt_attestation,
        runtime_id=str(context["runtime_id"]),
        session_id=str(context["session_key"]),
        document_reviews=document_evidence,
    )
    request_digest = sha256_json(
        ["capability-complete", closeout_request_id, receipt["receipt_hash"]]
    )
    return service.dispatch(
        "acknowledge_closeout",
        {
            "contract_version": 1,
            "operation_id": "capability-" + request_digest[:48],
            "runtime_id": str(context["runtime_id"]),
            "adapter_version": "1.3.0",
            "session_id": str(context["session_key"]),
            "occurred_at": utc_now(),
            "closeout_request_id": closeout_request_id,
            "acknowledgement_outcome": "completed",
            "sync_receipt": receipt,
        },
    )


_HANDLERS = {
    "scan_dependencies": _scan,
    "query_dependencies": _query,
    "update_fractal_document": _update,
    "complete_closeout": _complete,
}


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    operation = args[0] if len(args) == 1 else ""
    try:
        if operation not in CAPABILITY_OPERATIONS:
            raise ContractError("contract_action_unknown", "unknown capability")
        result = _HANDLERS[operation](_read_request())
        _emit(result)
        return 0
    except (ContractError, PathBoundaryError) as exc:
        _emit({"status": "invalid", "reason_code": exc.reason_code})
        return getattr(exc, "exit_code", 64)
    except Exception:
        _emit({"status": "error", "reason_code": "capability_fallback"})
        sys.stderr.write("fractal-capability:capability_fallback\n")
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
