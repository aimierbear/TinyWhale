"""Deterministic evidence collection and trusted local receipts."""

from __future__ import annotations

import hashlib
import hmac
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping

from .paths import file_fingerprint, resolve_rule, safe_project_path
from .util import canonical_json, sha256_json, sha256_text, utc_now

TRUSTED_GATE_RUNNER = "fractal-local-gate"
TRUSTED_GATE_VERSION = "1"
CANONICAL_SKILL = "fractal-self-description"
CANONICAL_SKILL_VERSION = "1.0.0"
CANONICAL_AUDIT_MODEL = "local-structured-audit"
CANONICAL_AUDIT_MODEL_VERSION = "1"
AUDIT_OUTPUT_FIELDS = frozenset(
    {"schema_version", "result", "decision_class", "remediation"}
)
REMEDIATION_CODES = frozenset(
    {
        "evidence_inconclusive",
        "gate_failed",
        "manual_review_required",
        "missing_test_evidence",
        "rule_violation",
    }
)
ReceiptSigner = Callable[..., str]


def _valid_receipt_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or "T" not in value:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def project_evidence(
    root: Path,
    paths: list[str],
    *,
    include_derived: bool = True,
) -> dict[str, Any]:
    """Collect hashes only; derived outputs may be excluded from sync witnesses."""
    root = root.resolve(strict=True)
    files: list[dict[str, str]] = []
    rules: dict[str, str] = {}
    for relative in sorted(set(paths)):
        target = safe_project_path(root, relative)
        files.append(
            {
                "path": relative,
                "fingerprint": file_fingerprint(target),
            }
        )
        if include_derived:
            resolution = resolve_rule(root, target)
            if resolution.rule_path is not None:
                rule_relative = resolution.rule_path.relative_to(root).as_posix()
                rules[rule_relative] = resolution.rule_fingerprint

    documents = []
    graphs = []
    if include_derived:
        for candidate in sorted(root.glob("README*")):
            if candidate.is_file() and not candidate.is_symlink():
                documents.append(
                    {
                        "path": candidate.relative_to(root).as_posix(),
                        "fingerprint": file_fingerprint(candidate),
                    }
                )
        context = root / ".context"
        if context.is_dir() and not context.is_symlink():
            for candidate in sorted(context.iterdir()):
                if candidate.is_file() and not candidate.is_symlink():
                    graphs.append(
                        {
                            "path": candidate.relative_to(root).as_posix(),
                            "fingerprint": file_fingerprint(candidate),
                        }
                    )
    value = {
        "files": files,
        "rules": [
            {"path": path, "fingerprint": fingerprint}
            for path, fingerprint in sorted(rules.items())
        ],
        "documents": documents,
        "graphs": graphs,
    }
    return {"value": value, "hash": sha256_json(value)}


def evidence_matches_files(
    files: list[dict[str, str]],
    evidence: Mapping[str, Any],
) -> bool:
    """Require journal fingerprints and freshly observed file hashes to agree."""
    value = evidence.get("value")
    observed = value.get("files") if isinstance(value, Mapping) else None
    if not isinstance(observed, list):
        return False
    expected_pairs = [
        (item.get("path"), item.get("after_fingerprint"))
        for item in files
        if isinstance(item, Mapping)
    ]
    observed_pairs = [
        (item.get("path"), item.get("fingerprint"))
        for item in observed
        if isinstance(item, Mapping)
    ]
    return (
        len(expected_pairs) == len(files)
        and len(observed_pairs) == len(observed)
        and sorted(expected_pairs) == sorted(observed_pairs)
    )


def run_local_gate(root: Path) -> dict[str, str]:
    """Run the fixed, non-LLM local gate and return only hashed output."""
    try:
        result = subprocess.run(
            ["git", "-C", str(root.resolve(strict=True)), "diff", "--check"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
            check=False,
        )
        output_hash = hashlib.sha256(
            result.stdout + b"\0" + result.stderr
        ).hexdigest()
        status = "passed" if result.returncode == 0 else "failed"
    except (OSError, subprocess.TimeoutExpired):
        output_hash = sha256_text("local-gate-unavailable")
        status = "failed"
    core = {
        "runner_id": TRUSTED_GATE_RUNNER,
        "runner_version": TRUSTED_GATE_VERSION,
        "result": status,
        "output_hash": output_hash,
    }
    return {**core, "receipt_hash": sha256_json(core)}


def _skill_identity() -> dict[str, str]:
    return {
        "skill_id": CANONICAL_SKILL,
        "skill_version": CANONICAL_SKILL_VERSION,
    }


def _audit_model_identity() -> dict[str, str]:
    return {
        "model_id": CANONICAL_AUDIT_MODEL,
        "model_version": CANONICAL_AUDIT_MODEL_VERSION,
    }


def receipt_unsigned_core(receipt: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in receipt.items()
        if key not in {"attestation", "receipt_hash"}
    }


def build_sync_receipt(
    project_root: Path,
    closeout: Mapping[str, Any],
    *,
    signer: ReceiptSigner,
    runtime_id: str,
    session_id: str,
    document_reviews: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    paths = [item["path"] for item in closeout["changed_files"]]
    evidence = project_evidence(project_root, paths, include_derived=False)
    if not evidence_matches_files(closeout["changed_files"], evidence):
        raise ValueError("closeout files do not match repository evidence")
    unsigned: dict[str, Any] = {
        "changed_set_id": closeout["changed_set_id"],
        "watermark": closeout["watermark"],
        "files": closeout["changed_files"],
        "evidence_hash": evidence["hash"],
        "documents": list(document_reviews or []),
        "gate": run_local_gate(project_root),
        "skill": _skill_identity(),
        "audit_model": _audit_model_identity(),
        "timestamp": utc_now(),
    }
    attestation = signer(
        purpose="sync",
        runtime_id=runtime_id,
        session_key=session_id,
        subject_id=str(closeout["closeout_request_id"]),
        unsigned_core=unsigned,
    )
    core = {**unsigned, "attestation": attestation}
    return {**core, "receipt_hash": sha256_json(core)}


def validate_sync_receipt(
    receipt: Mapping[str, Any],
    *,
    changed_set_id: str,
    watermark: int,
    files: list[dict[str, str]],
    evidence_hash: str,
    evidence_files: list[dict[str, str]],
    trusted_gate: Mapping[str, Any],
    trusted_attestation: str,
    document_reviews: list[dict[str, str]] | None = None,
) -> bool:
    if not isinstance(receipt, Mapping):
        return False
    required = {
        "changed_set_id",
        "watermark",
        "files",
        "evidence_hash",
        "documents",
        "gate",
        "skill",
        "audit_model",
        "timestamp",
        "attestation",
        "receipt_hash",
    }
    if set(receipt) != required:
        return False
    if not _valid_receipt_timestamp(receipt["timestamp"]):
        return False
    core = {key: value for key, value in receipt.items() if key != "receipt_hash"}
    if receipt["receipt_hash"] != sha256_json(core):
        return False
    if not hmac_compare(str(receipt["attestation"]), trusted_attestation):
        return False
    gate = receipt["gate"]
    if not isinstance(gate, Mapping) or set(gate) != {
        "runner_id",
        "runner_version",
        "result",
        "output_hash",
        "receipt_hash",
    }:
        return False
    gate_core = {key: value for key, value in gate.items() if key != "receipt_hash"}
    if gate["receipt_hash"] != sha256_json(gate_core):
        return False
    if (
        gate["runner_id"] != TRUSTED_GATE_RUNNER
        or gate["runner_version"] != TRUSTED_GATE_VERSION
        or gate["result"] != "passed"
        or gate != trusted_gate
    ):
        return False
    skill = receipt["skill"]
    if skill != _skill_identity() or receipt["audit_model"] != _audit_model_identity():
        return False
    return (
        receipt["changed_set_id"] == changed_set_id
        and receipt["watermark"] == watermark
        and receipt["files"] == files
        and receipt["evidence_hash"] == evidence_hash
        and receipt["documents"] == list(document_reviews or [])
        and sorted(
            (item.get("path"), item.get("after_fingerprint"))
            for item in files
        )
        == sorted(
            (item.get("path"), item.get("fingerprint"))
            for item in evidence_files
        )
    )


def validate_audit_output(value: Mapping[str, Any]) -> bool:
    if not isinstance(value, Mapping) or set(value) != AUDIT_OUTPUT_FIELDS:
        return False
    if value.get("schema_version") != 1:
        return False
    if value.get("result") not in {"verified", "inconclusive", "failed"}:
        return False
    if value.get("decision_class") not in {
        "technical",
        "product_intent",
        "financial_cost",
        "credential_lifecycle",
        "irreversible_action",
    }:
        return False
    remediation = value.get("remediation")
    return (
        isinstance(remediation, list)
        and len(remediation) <= 10
        and all(item in REMEDIATION_CODES for item in remediation)
    )


def build_audit_receipt(
    project_root: Path,
    bundle: Mapping[str, Any],
    audit_output: Mapping[str, Any],
    *,
    signer: ReceiptSigner,
    runtime_id: str,
    session_id: str,
    audit_token: str,
) -> dict[str, Any]:
    if not validate_audit_output(audit_output):
        raise ValueError("audit output does not match the closed schema")
    paths = [item["path"] for item in bundle["files"]]
    evidence = project_evidence(project_root, paths)
    if not evidence_matches_files(bundle["files"], evidence):
        raise ValueError("audit files do not match repository evidence")
    unsigned: dict[str, Any] = {
        "bundle_hash": bundle["bundle_hash"],
        "event_ids": bundle["event_ids"],
        "files": bundle["files"],
        "evidence_hash": evidence["hash"],
        "gate": run_local_gate(project_root),
        "skill": _skill_identity(),
        "audit_model": _audit_model_identity(),
        "audit_output": dict(audit_output),
        "audit_output_hash": sha256_json(audit_output),
        "timestamp": utc_now(),
    }
    attestation = signer(
        purpose="audit",
        runtime_id=runtime_id,
        session_key=session_id,
        subject_id=audit_token,
        unsigned_core=unsigned,
    )
    core = {**unsigned, "attestation": attestation}
    return {**core, "receipt_hash": sha256_json(core)}


def validate_audit_receipt(
    receipt: Mapping[str, Any],
    *,
    bundle_hash: str,
    event_ids: list[str],
    files: list[dict[str, str]],
    evidence_hash: str,
    evidence_files: list[dict[str, str]],
    audit_result: str,
    decision_class: str,
    trusted_gate: Mapping[str, Any],
    trusted_attestation: str,
) -> bool:
    if not isinstance(receipt, Mapping):
        return False
    required = {
        "bundle_hash",
        "event_ids",
        "files",
        "evidence_hash",
        "gate",
        "skill",
        "audit_model",
        "audit_output",
        "audit_output_hash",
        "timestamp",
        "attestation",
        "receipt_hash",
    }
    if set(receipt) != required:
        return False
    if not _valid_receipt_timestamp(receipt["timestamp"]):
        return False
    core = {key: value for key, value in receipt.items() if key != "receipt_hash"}
    if receipt["receipt_hash"] != sha256_json(core):
        return False
    if not hmac_compare(str(receipt["attestation"]), trusted_attestation):
        return False
    output = receipt["audit_output"]
    if (
        not validate_audit_output(output)
        or receipt["audit_output_hash"] != sha256_json(output)
        or output["result"] != audit_result
        or output["decision_class"] != decision_class
    ):
        return False
    gate = receipt["gate"]
    gate_core = (
        {key: value for key, value in gate.items() if key != "receipt_hash"}
        if isinstance(gate, Mapping)
        else {}
    )
    if (
        not isinstance(gate, Mapping)
        or gate.get("receipt_hash") != sha256_json(gate_core)
        or gate.get("runner_id") != TRUSTED_GATE_RUNNER
        or gate.get("result") != "passed"
        or gate != trusted_gate
    ):
        return False
    skill = receipt["skill"]
    if skill != _skill_identity() or receipt["audit_model"] != _audit_model_identity():
        return False
    return (
        receipt["bundle_hash"] == bundle_hash
        and receipt["event_ids"] == event_ids
        and receipt["files"] == files
        and receipt["evidence_hash"] == evidence_hash
        and sorted(
            (item.get("path"), item.get("after_fingerprint"))
            for item in files
        )
        == sorted(
            (item.get("path"), item.get("fingerprint"))
            for item in evidence_files
        )
    )


def hmac_compare(left: str, right: str) -> bool:
    return hmac.compare_digest(left, right)


_ASSIGNMENT_SECRET = re.compile(
    r"""(?im)^([ \t]*["']?(?:[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|COOKIE|CREDENTIAL)[A-Z0-9_-]*|authorization|database_url)["']?[ \t]*[:=][ \t]*)(.*)$"""
)
_INLINE_SECRET = re.compile(
    r"""(?i)(["']?(?:[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|COOKIE|CREDENTIAL)[A-Z0-9_-]*|authorization|database_url)["']?\s*[:=]\s*["']?)([^"'\s,}\]]+)"""
)
_BEARER_SECRET = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}")
_URL_BASIC_AUTH = re.compile(
    r"(?i)(\b[a-z][a-z0-9+.-]*://[^/\s:@]+:)([^@\s/]+)(@)"
)
_TOKEN_SHAPE = re.compile(
    r"\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,})\b"
)
_PRIVATE_KEY = re.compile(
    r"(?is)-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|\Z)"
)


def redact_repository_text(value: str) -> str:
    redacted = _INLINE_SECRET.sub(r"\1[REDACTED]", value)
    redacted = _ASSIGNMENT_SECRET.sub(r"\1[REDACTED]", redacted)
    redacted = _BEARER_SECRET.sub("Bearer [REDACTED]", redacted)
    redacted = _URL_BASIC_AUTH.sub(r"\1[REDACTED]\3", redacted)
    redacted = _TOKEN_SHAPE.sub("[REDACTED]", redacted)
    return _PRIVATE_KEY.sub("[REDACTED PRIVATE KEY]", redacted)


def quote_untrusted_sources(
    sources: list[dict[str, str]],
    *,
    trusted_context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build no-tool audit input; repository text remains labelled data."""
    bounded = []
    for item in sources[:512]:
        bounded.append(
            {
                "source": str(item.get("source", "unknown"))[:120],
                "content": redact_repository_text(
                    str(item.get("content", ""))
                )[:16_384],
                "trust": "untrusted_repository_data",
            }
        )
    value = {
        "system_policy": "no_tools_closed_schema_v1",
        "sources": bounded,
        "allowed_output_fields": sorted(AUDIT_OUTPUT_FIELDS),
    }
    if trusted_context is not None:
        value["trusted_context"] = dict(trusted_context)
    return value
