"""Crash recovery and redacted emergency evidence."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping

from .evidence import project_evidence, run_local_gate
from .graph import GraphReconciler
from .paths import (
    PathBoundaryError,
    open_directory_no_symlinks,
    safe_project_path,
)
from .state import StateStore
from .util import has_unsafe_symlink_component, sha256_text, utc_now

_SENSITIVE_DETAIL_MARKERS = (
    "cookie",
    "credential",
    "key",
    "password",
    "path",
    "secret",
    "token",
)


def _safe_detail(detail: Mapping[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for raw_key, value in detail.items():
        key = str(raw_key)[:64]
        lowered = key.lower()
        if any(marker in lowered for marker in _SENSITIVE_DETAIL_MARKERS):
            continue
        if isinstance(value, bool | int | float) or value is None:
            safe[key] = value
        elif isinstance(value, str) and len(value) <= 120 and "/" not in value:
            safe[key] = value
    return safe


def write_emergency_event(
    target: Path,
    *,
    category: str,
    subject: str,
    reason_code: str,
    detail: Mapping[str, Any],
) -> None:
    """Append one private, closed and path-free JSONL record."""
    target = target.expanduser()
    if has_unsafe_symlink_component(target.parent):
        raise ValueError("emergency ancestor must not be a symlink")
    if target.is_symlink():
        raise ValueError("emergency target must not be a symlink")
    payload = {
        "schema_version": 1,
        "category": category[:64],
        "subject_hash": sha256_text(subject),
        "reason_code": reason_code[:64],
        "detail": _safe_detail(detail),
        "occurred_at": utc_now(),
    }
    encoded = (
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")
    parent_descriptor = open_directory_no_symlinks(
        target.parent,
        create=True,
        mode=0o700,
        opener=os.open,
        mkdirer=os.mkdir,
    )
    try:
        descriptor = os.open(
            target.name,
            os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_descriptor,
        )
        try:
            os.write(descriptor, encoded)
            os.fsync(descriptor)
            os.fchmod(descriptor, 0o600)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_descriptor)


class Doctor:
    """Replay durable primary events into recoverable derived artifacts."""

    def __init__(self, *, state_root: Path) -> None:
        self.store = StateStore(state_root)

    def recover(self) -> dict[str, Any]:
        replayed = 0
        rejected = 0
        reopened = 0
        reconciled = 0
        imported = 0
        emergency = self.store.state_root / "emergency.jsonl"
        if emergency.is_file() and not emergency.is_symlink():
            for raw_line in emergency.read_text(
                encoding="utf-8",
                errors="replace",
            ).splitlines():
                try:
                    payload = json.loads(raw_line)
                    if not isinstance(payload, Mapping):
                        raise ValueError("emergency record is not an object")
                    if self.store.import_emergency_record(
                        record_hash=sha256_text(raw_line),
                        category=str(payload.get("category", "")),
                        subject_hash=str(payload.get("subject_hash", "")),
                        reason_code=str(payload.get("reason_code", "")),
                        detail=payload.get("detail", {})
                        if isinstance(payload.get("detail"), Mapping)
                        else {},
                    ):
                        imported += 1
                except (TypeError, ValueError):
                    rejected += 1
        for scope in self.store.active_scope_contexts():
            try:
                results = self.store.reconcile_scope(
                    scope_id=str(scope["scope_id"]),
                    runtime_id=str(scope["runtime_id"]),
                    session_key=str(scope["session_key"]),
                )
                reconciled += sum(
                    result.get("status") in {"recorded", "recorded_unowned"}
                    for result in results
                )
            except (OSError, PathBoundaryError, ValueError):
                rejected += 1
        pending_by_root: dict[str, list[dict[str, Any]]] = {}
        for event in self.store.pending_graph_events():
            pending_by_root.setdefault(str(event["root"]), []).append(event)
        graph = GraphReconciler(state_root=self.store.state_root)
        for raw_root, events in pending_by_root.items():
            try:
                root = Path(raw_root).resolve(strict=True)
                relatives = [
                    safe_project_path(root, str(event["path"]))
                    .relative_to(root)
                    .as_posix()
                    for event in events
                ]
                result = graph.scan(root, files=relatives)
                if result.get("status") != "ok":
                    rejected += len(events)
                    continue
                for event in events:
                    self.store.mark_graph_applied(
                        str(event["event_kind"]),
                        str(event["event_id"]),
                    )
                    replayed += 1
            except (OSError, PathBoundaryError, ValueError):
                rejected += len(events)
        for context in self.store.resolved_audit_contexts():
            try:
                root = Path(context["root"]).resolve(strict=True)
                bundle = context["bundle"]
                evidence = project_evidence(
                    root,
                    [item["path"] for item in bundle["files"]],
                )
                gate = run_local_gate(root)
                if (
                    evidence["hash"] == context["evidence_hash"]
                    and gate["receipt_hash"] == context["gate_hash"]
                ):
                    continue
                fingerprints = {
                    item["path"]: item["fingerprint"]
                    for item in evidence["value"]["files"]
                }
                if self.store.reopen_stale_audit(
                    decision_id=context["decision_id"],
                    fingerprints=fingerprints,
                    evidence_hash=evidence["hash"],
                    gate_hash=gate["receipt_hash"],
                ):
                    reopened += 1
            except (OSError, PathBoundaryError, ValueError):
                rejected += 1
        return {
            "status": "healthy" if rejected == 0 else "degraded",
            "replayed_graph_events": replayed,
            "rejected_graph_events": rejected,
            "reconciled_events": reconciled,
            "imported_emergency_records": imported,
            "reopened_audits": reopened,
            "counts": self.store.health_counts(),
        }
