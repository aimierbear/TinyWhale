"""Closed action and runtime-manifest contracts."""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

ACTION_CONTRACT_VERSION = 1
MANIFEST_SCHEMA_VERSION = 1
MAX_INPUT_BYTES = 1_048_576

ACTION_NAMES = (
    "begin_change_scope",
    "resolve_constraints",
    "confirm_constraint_delivery",
    "record_observed_change",
    "closeout_status",
    "end_change_scope",
    "acknowledge_closeout",
    "prepare_unowned_audit",
    "resolve_unowned",
)

REASON_CODES = frozenset(
    {
        "contract_action_unknown",
        "contract_field_invalid",
        "contract_field_missing",
        "contract_field_unknown",
        "contract_input_too_large",
        "contract_json_invalid",
        "contract_version_unsupported",
        "path_outside_root",
        "path_root_changed",
        "path_root_unknown",
        "rule_none",
        "rule_ignored",
        "event_outcome_unproven",
        "event_graph_reconciled",
        "event_document_updated",
        "event_duplicate",
        "state_scope_initializing",
        "state_lock_timeout",
        "state_watermark_stale",
        "state_internal_error",
        "audit_evidence_stale",
        "audit_receipt_invalid",
        "capability_fallback",
        "capability_artifact_verified",
        "capability_health_report",
        "capability_probe_current",
        "capability_probe_missing",
        "capability_runtime_version_unknown",
        "capability_unsupported",
        "adapter_identity_missing",
        "adapter_file_missing",
        "adapter_field_invalid",
        "config_concurrent_change",
    }
)

_ENVELOPE = {
    "contract_version",
    "operation_id",
    "runtime_id",
    "adapter_version",
    "session_id",
    "occurred_at",
}

_ACTION_FIELDS: dict[str, tuple[set[str], set[str]]] = {
    "begin_change_scope": ({"cwd", "scope_mode"}, set()),
    "resolve_constraints": (
        {"cwd", "file", "scope_id"},
        {"rule_fingerprint"},
    ),
    "confirm_constraint_delivery": (
        {"delivery_token", "proof_type", "proof_correlation"},
        set(),
    ),
    "record_observed_change": (
        {"cwd", "file", "scope_id", "evidence_type", "tool_outcome"},
        {"before_fingerprint", "after_fingerprint"},
    ),
    "closeout_status": (
        {"cwd", "scope_id", "completion_reason"},
        set(),
    ),
    "end_change_scope": ({"scope_id", "terminal_outcome"}, set()),
    "acknowledge_closeout": (
        {"closeout_request_id", "acknowledgement_outcome", "sync_receipt"},
        set(),
    ),
    "prepare_unowned_audit": (
        {"project", "selection", "skill_version"},
        {"event_ids", "cursor", "limit"},
    ),
    "resolve_unowned": (
        {
            "project",
            "event_ids",
            "audit_token",
            "audit_result",
            "decision_class",
            "audit_receipt",
        },
        set(),
    ),
}

_ENUMS: dict[tuple[str, str], frozenset[str]] = {
    ("begin_change_scope", "scope_mode"): frozenset(
        {"native_session", "manual_task"}
    ),
    ("confirm_constraint_delivery", "proof_type"): frozenset(
        {"host_acceptance_callback", "causal_retry_event"}
    ),
    ("record_observed_change", "evidence_type"): frozenset(
        {"native_success", "observed_final_diff"}
    ),
    ("record_observed_change", "tool_outcome"): frozenset(
        {"success", "failed", "cancelled", "unknown"}
    ),
    ("closeout_status", "completion_reason"): frozenset(
        {
            "turn_complete",
            "session_end",
            "agent_settled",
            "manual_check",
            "failed",
            "cancelled",
            "replaced",
            "unknown",
        }
    ),
    ("end_change_scope", "terminal_outcome"): frozenset(
        {"clean", "completed", "failed", "cancelled", "replaced", "unowned_only"}
    ),
    ("acknowledge_closeout", "acknowledgement_outcome"): frozenset(
        {"completed"}
    ),
    ("prepare_unowned_audit", "selection"): frozenset(
        {"explicit", "current_unresolved"}
    ),
    ("resolve_unowned", "audit_result"): frozenset(
        {"verified", "inconclusive", "failed"}
    ),
    ("resolve_unowned", "decision_class"): frozenset(
        {
            "technical",
            "product_intent",
            "financial_cost",
            "credential_lifecycle",
            "irreversible_action",
        }
    ),
}

_CAPABILITY_ENUMS = {
    "constraints": frozenset(
        {"native_inject", "block_then_retry", "active_read", "unsupported"}
    ),
    "constraint_delivery_proof": frozenset(
        {"host_acceptance_callback", "causal_retry_event", "unsupported"}
    ),
    "change_detection": frozenset(
        {"native_post_tool", "batch_reconcile", "manual_check", "unsupported"}
    ),
    "closeout": frozenset(
        {"blocking_gate", "nonblocking_reminder", "manual_check", "unsupported"}
    ),
    "skills": frozenset(
        {"shared_agents_dir", "native_install", "unsupported"}
    ),
    "rules": frozenset(
        {"native_rules", "agents_md", "shared_rules", "unsupported"}
    ),
}

_MANIFEST_FIELDS = {
    "manifest_schema_version",
    "action_contract_version",
    "id",
    "variants",
    "adapter_version",
    "adapter",
    "owner_id",
    "artifacts",
    "owned_node_template_hash",
    "capabilities",
    "verification",
    "rules_path",
    "skill_source",
}

_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_RFC3339_RE = re.compile(
    r"^(?P<year>[0-9]{4})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})"
    r"[Tt](?P<hour>[0-9]{2}):(?P<minute>[0-9]{2}):"
    r"(?P<second>[0-9]{2})(?:\.[0-9]+)?"
    r"(?P<zone>[Zz]|(?P<sign>[+-])(?P<zone_hour>[0-9]{2}):"
    r"(?P<zone_minute>[0-9]{2}))$"
)


class ContractError(ValueError):
    """A redacted contract failure with a stable process exit code."""

    def __init__(
        self,
        reason_code: str,
        message: str,
        *,
        exit_code: int = 64,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.reason_code = reason_code
        self.exit_code = exit_code
        self.retryable = retryable


class AdapterError(ValueError):
    """A redacted adapter payload failure with a stable reason code."""

    def __init__(self, reason_code: str, field: str) -> None:
        super().__init__(f"{reason_code}: {field}")
        self.reason_code = reason_code
        self.field = field


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ContractError("contract_field_invalid", f"invalid field: {field}")
    return value


def _valid_rfc3339(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    matched = _RFC3339_RE.fullmatch(value)
    if matched is None:
        return False
    try:
        datetime(
            int(matched["year"]),
            int(matched["month"]),
            int(matched["day"]),
        )
    except ValueError:
        return False
    hour = int(matched["hour"])
    minute = int(matched["minute"])
    second = int(matched["second"])
    zone_hour = int(matched["zone_hour"] or 0)
    zone_minute = int(matched["zone_minute"] or 0)
    if hour > 23 or minute > 59 or zone_hour > 23 or zone_minute > 59:
        return False
    if second < 60:
        return True
    if second > 60:
        return False
    zone_sign = -1 if matched["sign"] == "-" else 1
    utc_minute = minute - zone_minute * zone_sign
    utc_hour = hour - zone_hour * zone_sign - int(utc_minute < 0)
    return utc_hour in {23, -1} and utc_minute in {59, -1}


def validate_request(action: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and copy one closed action request."""
    if action not in ACTION_NAMES:
        raise ContractError("contract_action_unknown", "unknown action")
    if not isinstance(payload, Mapping):
        raise ContractError("contract_json_invalid", "request is not an object")
    if payload.get("contract_version") != ACTION_CONTRACT_VERSION:
        raise ContractError(
            "contract_version_unsupported",
            "unsupported action contract",
        )

    required, optional = _ACTION_FIELDS[action]
    required_fields = _ENVELOPE | required
    missing = sorted(required_fields - payload.keys())
    if missing:
        raise ContractError("contract_field_missing", "required field missing")
    unknown = sorted(payload.keys() - required_fields - optional)
    if unknown:
        raise ContractError("contract_field_unknown", "unknown request field")

    for field in (
        "operation_id",
        "runtime_id",
        "adapter_version",
        "session_id",
        "occurred_at",
    ):
        _require_string(payload[field], field)
    if len(str(payload["operation_id"])) > 128:
        raise ContractError("contract_field_invalid", "operation id is too long")
    if not _ID_RE.fullmatch(str(payload["runtime_id"])):
        raise ContractError("contract_field_invalid", "invalid runtime id")
    if not _HASH_RE.fullmatch(str(payload["session_id"])):
        raise ContractError("contract_field_invalid", "session id must be hashed")
    if not _valid_rfc3339(payload["occurred_at"]):
        raise ContractError("contract_field_invalid", "invalid occurred_at")

    for field in required:
        if field in {"sync_receipt", "audit_receipt"}:
            if not isinstance(payload[field], Mapping):
                raise ContractError("contract_field_invalid", f"invalid {field}")
        elif field == "event_ids":
            if not isinstance(payload[field], list) or not all(
                isinstance(item, str) and item for item in payload[field]
            ):
                raise ContractError("contract_field_invalid", "invalid event ids")
        else:
            _require_string(payload[field], field)

    for (enum_action, field), values in _ENUMS.items():
        if enum_action == action and payload.get(field) not in values:
            raise ContractError("contract_field_invalid", f"invalid enum: {field}")

    if action == "prepare_unowned_audit":
        if payload["skill_version"] != "1.0.0":
            raise ContractError(
                "contract_field_invalid",
                "non-canonical audit skill version",
            )
        if payload["selection"] == "explicit" and not payload.get("event_ids"):
            raise ContractError("contract_field_missing", "event ids required")
        if "limit" in payload and (
            not isinstance(payload["limit"], int)
            or not 1 <= int(payload["limit"]) <= 200
        ):
            raise ContractError("contract_field_invalid", "invalid audit limit")

    return dict(payload)


def validate_manifest(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Validate one closed runtime capability manifest."""
    if not isinstance(manifest, Mapping):
        raise ContractError("contract_json_invalid", "manifest is not an object")
    if manifest.get("manifest_schema_version") != MANIFEST_SCHEMA_VERSION:
        raise ContractError("contract_version_unsupported", "manifest schema")
    if manifest.get("action_contract_version") != ACTION_CONTRACT_VERSION:
        raise ContractError("contract_version_unsupported", "action contract")
    missing = sorted(_MANIFEST_FIELDS - manifest.keys())
    if missing:
        raise ContractError("contract_field_missing", "manifest field missing")
    unknown = sorted(manifest.keys() - _MANIFEST_FIELDS)
    if unknown:
        raise ContractError("contract_field_unknown", "manifest field unknown")

    manifest_id = _require_string(manifest["id"], "id")
    if not _ID_RE.fullmatch(manifest_id):
        raise ContractError("contract_field_invalid", "invalid manifest id")
    if not isinstance(manifest["variants"], list) or not all(
        isinstance(value, str) and value for value in manifest["variants"]
    ):
        raise ContractError("contract_field_invalid", "invalid variants")
    for field in (
        "adapter_version",
        "adapter",
        "owner_id",
        "owned_node_template_hash",
        "rules_path",
        "skill_source",
    ):
        _require_string(manifest[field], field)
    if not _HASH_RE.fullmatch(str(manifest["owned_node_template_hash"])):
        raise ContractError("contract_field_invalid", "invalid template hash")
    if not isinstance(manifest["artifacts"], list):
        raise ContractError("contract_field_invalid", "invalid artifacts")
    for artifact in manifest["artifacts"]:
        if not isinstance(artifact, Mapping) or set(artifact) != {
            "path",
            "sha256",
            "mode",
        }:
            raise ContractError("contract_field_invalid", "invalid artifact entry")
        artifact_path = _require_string(artifact["path"], "artifact path")
        relative = Path(artifact_path)
        if relative.is_absolute() or ".." in relative.parts:
            raise ContractError("path_outside_root", "artifact escaped root")
        if not _HASH_RE.fullmatch(str(artifact["sha256"])):
            raise ContractError("contract_field_invalid", "invalid artifact hash")
        if artifact["mode"] not in {"0644", "0755"}:
            raise ContractError("contract_field_invalid", "invalid artifact mode")

    capabilities = manifest["capabilities"]
    if not isinstance(capabilities, Mapping):
        raise ContractError("contract_field_invalid", "invalid capabilities")
    if set(capabilities) != set(_CAPABILITY_ENUMS):
        raise ContractError("contract_field_missing", "capability field mismatch")
    for name, allowed in _CAPABILITY_ENUMS.items():
        if capabilities.get(name) not in allowed:
            raise ContractError("contract_field_invalid", "invalid capability")
    if (
        capabilities["constraints"] == "block_then_retry"
        and capabilities["constraint_delivery_proof"] == "unsupported"
    ):
        raise ContractError(
            "capability_unsupported",
            "block-then-retry requires delivery proof",
        )
    for core in ("constraints", "change_detection", "closeout"):
        if capabilities[core] == "unsupported":
            raise ContractError("capability_unsupported", "core capability missing")

    verification = manifest["verification"]
    if not isinstance(verification, Mapping) or set(verification) != {
        "discover",
        "invoke",
        "effective",
    }:
        raise ContractError("contract_field_invalid", "invalid verification")
    for value in verification.values():
        if value not in {"fixture", "manual", "fallback", "native_probe"}:
            raise ContractError("contract_field_invalid", "invalid verification source")
    return dict(manifest)


def error_result(
    reason_code: str,
    *,
    operation_id: str = "",
    status: str = "invalid",
    retryable: bool = False,
) -> dict[str, Any]:
    """Return the common response envelope without echoing bad input."""
    return {
        "contract_version": ACTION_CONTRACT_VERSION,
        "status": status,
        "reason_code": reason_code,
        "operation_id": operation_id if len(operation_id) <= 128 else "",
        "retryable": retryable,
    }
