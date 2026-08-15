"""Automatic no-tool LLM audit orchestration for unowned technical changes."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Callable, Mapping

from .actions import ActionService
from .evidence import (
    build_audit_receipt,
    evidence_matches_files,
    project_evidence,
    quote_untrusted_sources,
    run_local_gate,
    validate_audit_output,
)
from .paths import resolve_rule, safe_project_path
from .util import sha256_text, utc_now


class AuditError(RuntimeError):
    pass


class AutomaticLLMAuditor:
    """Prepare exact evidence, invoke an LLM without tools, then verify its receipt."""

    def __init__(
        self,
        *,
        service: ActionService,
        model_runner: Callable[..., Mapping[str, Any]],
        skill_version: str = "1.0.0",
    ) -> None:
        self.service = service
        self.model_runner = model_runner
        self.skill_version = skill_version

    @staticmethod
    def _session(project: Path) -> str:
        return hashlib.sha256(
            f"fractal-automatic-auditor:{project.resolve(strict=True)}".encode("utf-8")
        ).hexdigest()

    def _request(
        self,
        *,
        project_root: Path,
        runtime_id: str,
        adapter_version: str,
        operation: str,
        **fields: Any,
    ) -> dict[str, Any]:
        return {
            "contract_version": 1,
            "operation_id": hashlib.sha256(
                f"{operation}:{utc_now()}".encode("utf-8")
            ).hexdigest()[:32],
            "runtime_id": runtime_id,
            "adapter_version": adapter_version,
            "session_id": self._session(project_root),
            "occurred_at": utc_now(),
            **fields,
        }

    @staticmethod
    def _sources(
        project: Path,
        bundle: Mapping[str, Any],
        evidence: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        value = evidence.get("value")
        if not isinstance(value, Mapping):
            raise AuditError("audit evidence has no source metadata")
        evidence_rules = {
            item["path"]: item["fingerprint"]
            for item in value.get("rules", [])
        }
        used_rules: set[str] = set()
        sources: list[dict[str, str]] = []
        for item in bundle["files"]:
            target = safe_project_path(project, item["path"])
            if target.is_symlink() or (target.exists() and not target.is_file()):
                raise AuditError("audit source is not a regular file")
            raw = target.read_bytes() if target.exists() else b""
            digest = hashlib.sha256()
            digest.update(b"file\0" if target.exists() else b"missing\0")
            if target.exists():
                digest.update(raw)
            if digest.hexdigest() != item["after_fingerprint"]:
                raise AuditError("audit source fingerprint changed")
            file_content = raw.decode("utf-8", errors="replace")
            sources.append(
                {
                    "source": f"audit_event_file:{item['path']}",
                    "content": file_content,
                }
            )
            rule = resolve_rule(project, target)
            if rule.rule_path is not None:
                rule_relative = rule.rule_path.relative_to(project).as_posix()
                rule_raw = rule.rule_path.read_bytes()
                rule_content = rule_raw.decode("utf-8", errors="strict")
                if (
                    evidence_rules.get(rule_relative) != sha256_text(rule_content)
                    or rule.rule_fingerprint != sha256_text(rule_content)
                ):
                    raise AuditError("audit rule source fingerprint changed")
                used_rules.add(rule_relative)
                sources.append(
                    {
                        "source": (
                            f"audit_event_rule:{item['path']}:{rule_relative}"
                        ),
                        "content": rule_content,
                    }
                )
            else:
                sources.append(
                    {
                        "source": f"audit_event_rule:{item['path']}:none",
                        "content": "NO_APPLICABLE_RULE",
                    }
                )
        if used_rules != set(evidence_rules):
            raise AuditError("audit rule source set changed")
        for source_type, metadata_key in (
            ("project_document", "documents"),
            ("project_graph", "graphs"),
        ):
            for item in value.get(metadata_key, []):
                target = safe_project_path(project, item["path"])
                if target.is_symlink() or not target.is_file():
                    raise AuditError("audit supporting source changed")
                raw = target.read_bytes()
                digest = hashlib.sha256()
                digest.update(b"file\0")
                digest.update(raw)
                if digest.hexdigest() != item["fingerprint"]:
                    raise AuditError("audit supporting source fingerprint changed")
                sources.append(
                    {
                        "source": f"{source_type}:{item['path']}",
                        "content": raw.decode("utf-8", errors="replace"),
                    }
                )
        return sources

    def run(
        self,
        *,
        project: Path,
        runtime_id: str,
        adapter_version: str,
    ) -> dict[str, Any]:
        project = project.resolve(strict=True)
        stale_preparation_retries = 0
        while True:
            prepared = self.service.dispatch(
                "prepare_unowned_audit",
                self._request(
                    project_root=project,
                    runtime_id=runtime_id,
                    adapter_version=adapter_version,
                    operation="prepare",
                    project=str(project),
                    selection="current_unresolved",
                    skill_version=self.skill_version,
                    limit=200,
                ),
            )
            if prepared.get("status") not in {"prepared", "duplicate"}:
                if (
                    prepared.get("status") == "stale"
                    and stale_preparation_retries < 1
                ):
                    stale_preparation_retries += 1
                    for scope in self.service.store.active_scope_contexts():
                        if Path(scope["root"]).resolve(strict=True) != project:
                            continue
                        self.service.store.reconcile_scope(
                            scope_id=str(scope["scope_id"]),
                            runtime_id=str(scope["runtime_id"]),
                            session_key=str(scope["session_key"]),
                        )
                    continue
                raise AuditError(
                    f"audit preparation failed: {prepared.get('reason_code', 'unknown')}"
                )
            bundle = prepared["audit_bundle"]
            if not bundle["event_ids"]:
                return {
                    "status": "clean",
                    "reason_code": "rule_none",
                    "remaining_unowned": 0,
                }
            evidence = project_evidence(
                project,
                [item["path"] for item in bundle["files"]],
            )
            if (
                evidence["hash"] != bundle["evidence_hash"]
                or not evidence_matches_files(bundle["files"], evidence)
            ):
                raise AuditError("audit bundle evidence is stale")
            prompt = quote_untrusted_sources(
                self._sources(project, bundle, evidence),
                trusted_context={
                    "evidence_hash": evidence["hash"],
                    "gate": run_local_gate(project),
                },
            )
            output = self.model_runner(prompt, tools=())
            if not validate_audit_output(output):
                raise AuditError("LLM output failed the closed audit schema")
            receipt = build_audit_receipt(
                project,
                bundle,
                output,
                signer=self.service.store.receipt_attestation,
                runtime_id=runtime_id,
                session_id=self._session(project),
                audit_token=prepared["audit_token"],
            )
            result = self.service.dispatch(
                "resolve_unowned",
                self._request(
                    project_root=project,
                    runtime_id=runtime_id,
                    adapter_version=adapter_version,
                    operation="resolve",
                    project=str(project),
                    event_ids=bundle["event_ids"],
                    audit_token=prepared["audit_token"],
                    audit_result=output["result"],
                    decision_class=output["decision_class"],
                    audit_receipt=receipt,
                ),
            )
            if (
                result.get("status") != "resolved"
                or int(result.get("remaining_unowned", 0)) == 0
            ):
                return result
