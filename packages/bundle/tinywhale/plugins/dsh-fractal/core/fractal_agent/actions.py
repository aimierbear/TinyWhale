"""Validated orchestration for the nine public fractal actions."""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path
from typing import Any, Callable, Mapping

from .contract import (
    ACTION_CONTRACT_VERSION,
    ContractError,
    error_result,
    validate_request,
)
from .document import document_review_evidence, mint_document_candidates
from .evidence import (
    build_sync_receipt,
    evidence_matches_files,
    project_evidence,
    receipt_unsigned_core,
    run_local_gate,
    validate_audit_receipt,
    validate_sync_receipt,
)
from .graph import GraphReconciler
from .paths import (
    PathBoundaryError,
    discover_project_root,
    file_fingerprint,
    graph_code_file,
    resolve_rule,
    safe_project_path,
    supported_code_file,
)
from .recovery import write_emergency_event
from .state import StateStore
from .util import sha256_json, sha256_text

_MISSING_FINGERPRINT = hashlib.sha256(b"missing\0").hexdigest()
_USER_AUTHORIZATION_CLASSES = frozenset(
    {
        "product_intent",
        "financial_cost",
        "credential_lifecycle",
        "irreversible_action",
    }
)


def _git_head_fingerprint(root: Path, relative_path: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), "show", f"HEAD:{relative_path}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        return _MISSING_FINGERPRINT
    digest = hashlib.sha256()
    digest.update(b"file\0")
    digest.update(result.stdout)
    return digest.hexdigest()


class ActionService:
    """Bind the stable contract to the state and evidence owners."""

    def __init__(
        self,
        *,
        state_root: Path,
        failure_injector: Callable[[str], None] | None = None,
        graph_reconciler: GraphReconciler | None = None,
    ) -> None:
        self.store = StateStore(state_root)
        self.failure_injector = failure_injector or (lambda _checkpoint: None)
        self.graph_reconciler = graph_reconciler or GraphReconciler(
            state_root=state_root
        )

    @staticmethod
    def _response(request: Mapping[str, Any], value: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "contract_version": ACTION_CONTRACT_VERSION,
            "operation_id": request["operation_id"],
            "retryable": False,
            **dict(value),
        }

    def dispatch(self, action: str, request: Mapping[str, Any]) -> dict[str, Any]:
        operation_id = (
            str(request.get("operation_id", ""))
            if isinstance(request, Mapping)
            else ""
        )
        try:
            validated = validate_request(action, request)
            request_digest = sha256_json([action, validated])
            uncached_actions = {
                "closeout_status",
                "resolve_constraints",
                "prepare_unowned_audit",
            }
            if action not in uncached_actions:
                reservation, cached = self.store.reserve_operation(
                    runtime_id=validated["runtime_id"],
                    session_key=validated["session_id"],
                    operation_id=validated["operation_id"],
                    action=action,
                    request_digest=request_digest,
                )
                if reservation == "completed":
                    assert cached is not None
                    return cached
                if reservation == "pending":
                    return self._response(
                        validated,
                        {
                            "status": "pending",
                            "reason_code": "state_scope_initializing",
                            "retryable": True,
                        },
                    )
            method = getattr(self, f"_action_{action}")
            response = self._response(validated, method(validated))
            if action in uncached_actions:
                return response
            try:
                return self.store.complete_operation(
                    runtime_id=validated["runtime_id"],
                    session_key=validated["session_id"],
                    operation_id=validated["operation_id"],
                    action=action,
                    request_digest=request_digest,
                    response=response,
                )
            except Exception:
                try:
                    write_emergency_event(
                        self.store.state_root / "emergency.jsonl",
                        category="post_write_failure",
                        subject=(
                            f"{validated['runtime_id']}:"
                            f"{validated['session_id']}:"
                            f"{validated['operation_id']}"
                        ),
                        reason_code="state_internal_error",
                        detail={"action": action},
                    )
                except (OSError, ValueError):
                    pass
                raise
        except PathBoundaryError as exc:
            return error_result(exc.reason_code, operation_id=operation_id)
        except ContractError as exc:
            return error_result(
                exc.reason_code,
                operation_id=operation_id,
                status="error" if exc.exit_code != 64 else "invalid",
                retryable=exc.retryable,
            )

    @staticmethod
    def _root(cwd: str) -> Path:
        return discover_project_root(cwd)

    def _action_begin_change_scope(
        self,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        root = self._root(request["cwd"])
        return self.store.begin_scope(
            root,
            request["runtime_id"],
            request["session_id"],
            request["scope_mode"],
        )

    def _action_resolve_constraints(
        self,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        scope = self.store.scope_info(
            request["scope_id"],
            request["runtime_id"],
            request["session_id"],
        )
        root = Path(scope["root"]).resolve(strict=True)
        requested_root = self._root(request["cwd"])
        if requested_root != root:
            raise PathBoundaryError("path_root_changed", "scope root changed")
        target = safe_project_path(root, request["file"])
        relative = target.relative_to(root).as_posix()
        resolution = resolve_rule(root, target)
        current = file_fingerprint(target)
        self.store.remember_before(
            request["scope_id"],
            request["runtime_id"],
            request["session_id"],
            relative,
            current,
        )
        if resolution.status != "applied":
            return {
                "status": resolution.status,
                "reason_code": resolution.reason_code,
                "constraints": "",
            }
        if (
            request.get("rule_fingerprint")
            and request["rule_fingerprint"] != resolution.rule_fingerprint
        ):
            return {
                "status": "stale",
                "reason_code": "audit_evidence_stale",
                "constraints": "",
            }
        delivery = self.store.prepare_delivery(
            scope_id=request["scope_id"],
            runtime_id=request["runtime_id"],
            session_key=request["session_id"],
            directory_hash=sha256_text(target.parent.relative_to(root).as_posix()),
            rule_fingerprint=resolution.rule_fingerprint,
        )
        return {
            **delivery,
            "constraints": resolution.constraints,
            "rule_path_hash": resolution.rule_path_hash,
        }

    def _action_confirm_constraint_delivery(
        self,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        return self.store.confirm_delivery(
            runtime_id=request["runtime_id"],
            session_key=request["session_id"],
            token=request["delivery_token"],
            proof_type=request["proof_type"],
            proof_correlation=request["proof_correlation"],
        )

    def _action_record_observed_change(
        self,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        scope = self.store.scope_info(
            request["scope_id"],
            request["runtime_id"],
            request["session_id"],
        )
        root = Path(scope["root"]).resolve(strict=True)
        if self._root(request["cwd"]) != root:
            raise PathBoundaryError("path_root_changed", "scope root changed")
        target = safe_project_path(root, request["file"])
        if not supported_code_file(target):
            return {"status": "ignored", "reason_code": "rule_ignored"}
        relative = target.relative_to(root).as_posix()
        current = file_fingerprint(target)
        supplied_after = request.get("after_fingerprint")
        if supplied_after is not None and supplied_after != current:
            return {"status": "stale", "reason_code": "audit_evidence_stale"}

        original = scope["baseline"].get(relative)
        if original is None:
            original = _git_head_fingerprint(root, relative)
        supplied_before = request.get("before_fingerprint")
        if supplied_before is not None and supplied_before != original:
            return {"status": "stale", "reason_code": "audit_evidence_stale"}
        previous = self.store.known_fingerprint(request["scope_id"], relative)
        before = previous or original
        if current == before and current == original:
            if previous is None:
                self.store.remember_before(
                    request["scope_id"],
                    request["runtime_id"],
                    request["session_id"],
                    relative,
                    current,
                )
            return {"status": "no_change", "reason_code": "rule_none"}
        if request["evidence_type"] == "native_success":
            if request["tool_outcome"] != "success":
                if current == before:
                    return {"status": "no_change", "reason_code": "rule_none"}
                return {
                    "status": "unproven",
                    "reason_code": "event_outcome_unproven",
                }

        self.failure_injector("before_state_commit")
        result = self.store.record_change(
            scope_id=request["scope_id"],
            runtime_id=request["runtime_id"],
            session_key=request["session_id"],
            path=relative,
            before_fingerprint=before,
            after_fingerprint=current,
            evidence_type=request["evidence_type"],
            graph_relevant=graph_code_file(Path(relative)),
        )
        if (
            result.get("event_id")
            and result.get("event_kind")
            and graph_code_file(Path(relative))
        ):
            self.failure_injector("after_state_commit_before_graph_queue")
        return result

    def _action_closeout_status(
        self,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        scope = self.store.scope_info(
            request["scope_id"],
            request["runtime_id"],
            request["session_id"],
        )
        root = Path(scope["root"]).resolve(strict=True)
        if self._root(request["cwd"]) != root:
            raise PathBoundaryError("path_root_changed", "scope root changed")
        self.store.reconcile_scope(
            scope_id=request["scope_id"],
            runtime_id=request["runtime_id"],
            session_key=request["session_id"],
        )
        changed_set = self.store.current_changed_set(
            int(scope["session_row_id"]),
            request["runtime_id"],
            request["session_id"],
        )
        graph = self.graph_reconciler.classify(
            root,
            [item["path"] for item in changed_set["files"]],
        )
        graph_result = graph.get("graph")
        if isinstance(graph_result, Mapping) and graph_result.get("status") == "ok":
            self.store.mark_session_graph_paths_applied(
                session_id=int(scope["session_row_id"]),
                watermark=int(changed_set["watermark"]),
                paths=[item["path"] for item in changed_set["files"]],
            )
        evidence = project_evidence(
            root,
            [item["path"] for item in changed_set["files"]],
            include_derived=False,
        )
        if not evidence_matches_files(changed_set["files"], evidence):
            return {"status": "stale", "reason_code": "state_watermark_stale"}
        closeout = self.store.create_closeout_request(
            scope_id=request["scope_id"],
            runtime_id=request["runtime_id"],
            session_key=request["session_id"],
            changed_set=changed_set,
            evidence_hash=evidence["hash"],
        )
        saved_graph_review = self.store.graph_review(
            changed_set["changed_set_id"]
        )
        if saved_graph_review is not None:
            graph = {**graph, **saved_graph_review}
        elif (
            graph.get("decision") == "review"
            and closeout.get("status") in {"needs_closeout", "already_reminded"}
        ):
            self.store.remember_graph_review(
                changed_set["changed_set_id"],
                graph,
            )
        closeout = {**closeout, "graph": graph}
        if (
            graph.get("decision") == "review"
            and closeout.get("status") in {"needs_closeout", "already_reminded"}
            and isinstance(closeout.get("closeout_request_id"), str)
        ):
            closeout["document_candidates"] = mint_document_candidates(
                self.store,
                root=root,
                closeout_request_id=closeout["closeout_request_id"],
                targets=graph.get("targets", []),
            )
            self.store.remember_document_requirements(
                changed_set["changed_set_id"],
                targets=list(graph.get("targets", [])),
                candidates=closeout["document_candidates"],
            )
        if (
            graph.get("decision") == "no_drift"
            and closeout.get("status") in {"needs_closeout", "already_reminded"}
        ):
            receipt = build_sync_receipt(
                root,
                closeout,
                signer=self.store.receipt_attestation,
                runtime_id=request["runtime_id"],
                session_id=request["session_id"],
            )
            acknowledged = self._action_acknowledge_closeout(
                {
                    **request,
                    "closeout_request_id": closeout["closeout_request_id"],
                    "acknowledgement_outcome": "completed",
                    "sync_receipt": receipt,
                }
            )
            if acknowledged.get("status") == "acknowledged":
                return {
                    **closeout,
                    "status": "graph_reconciled",
                    "reason_code": "event_graph_reconciled",
                    "acknowledged_watermark": acknowledged[
                        "acknowledged_watermark"
                    ],
                }
            return {**closeout, **acknowledged}
        return closeout

    def _action_end_change_scope(
        self,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        return self.store.end_scope(
            scope_id=request["scope_id"],
            runtime_id=request["runtime_id"],
            session_key=request["session_id"],
            terminal_outcome=request["terminal_outcome"],
        )

    def _action_acknowledge_closeout(
        self,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        context = self.store.closeout_context(
            request["closeout_request_id"],
            request["runtime_id"],
            request["session_id"],
        )
        if context is None:
            return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
        if context["status"] == "completed":
            if (
                request["sync_receipt"].get("receipt_hash")
                != context["receipt_hash"]
            ):
                return {
                    "status": "invalid",
                    "reason_code": "audit_receipt_invalid",
                }
            return self.store.complete_closeout(
                request_id=request["closeout_request_id"],
                runtime_id=request["runtime_id"],
                session_key=request["session_id"],
                changed_set_id=context["changed_set_id"],
                watermark=int(context["watermark"]),
                receipt_hash=str(context["receipt_hash"] or ""),
            )
        root = Path(context["root"]).resolve(strict=True)
        document_evidence = document_review_evidence(self.store, context)
        if document_evidence is None:
            return {"status": "stale", "reason_code": "state_watermark_stale"}
        evidence = project_evidence(
            root,
            [item["path"] for item in context["files"]],
            include_derived=False,
        )
        if evidence["hash"] != context["evidence_hash"]:
            return {"status": "stale", "reason_code": "state_watermark_stale"}
        if not evidence_matches_files(context["files"], evidence):
            return {"status": "stale", "reason_code": "state_watermark_stale"}
        receipt = request["sync_receipt"]
        unsigned_core = receipt_unsigned_core(receipt)
        trusted_attestation = self.store.receipt_attestation(
            purpose="sync",
            runtime_id=request["runtime_id"],
            session_key=request["session_id"],
            subject_id=request["closeout_request_id"],
            unsigned_core=unsigned_core,
        )
        trusted_gate = run_local_gate(root)
        if not validate_sync_receipt(
            receipt,
            changed_set_id=context["changed_set_id"],
            watermark=int(context["watermark"]),
            files=context["files"],
            evidence_hash=evidence["hash"],
            evidence_files=evidence["value"]["files"],
            trusted_gate=trusted_gate,
            trusted_attestation=trusted_attestation,
            document_reviews=document_evidence,
        ):
            return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
        self.failure_injector("before_closeout_final_validation")

        def final_validator() -> bool:
            final_documents = document_review_evidence(self.store, context)
            if final_documents is None:
                return False
            final_evidence = project_evidence(
                root,
                [item["path"] for item in context["files"]],
                include_derived=False,
            )
            return (
                final_evidence["hash"] == context["evidence_hash"]
                and evidence_matches_files(context["files"], final_evidence)
                and validate_sync_receipt(
                    receipt,
                    changed_set_id=context["changed_set_id"],
                    watermark=int(context["watermark"]),
                    files=context["files"],
                    evidence_hash=final_evidence["hash"],
                    evidence_files=final_evidence["value"]["files"],
                    trusted_gate=run_local_gate(root),
                    trusted_attestation=trusted_attestation,
                    document_reviews=final_documents,
                )
                and final_documents == document_evidence
            )

        return self.store.complete_closeout(
            request_id=request["closeout_request_id"],
            runtime_id=request["runtime_id"],
            session_key=request["session_id"],
            changed_set_id=context["changed_set_id"],
            watermark=int(context["watermark"]),
            receipt_hash=str(receipt["receipt_hash"]),
            final_validator=final_validator,
        )

    def _action_prepare_unowned_audit(
        self,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        root = self._root(request["project"])
        selected_ids = (
            list(request.get("event_ids", []))
            if request["selection"] == "explicit"
            else None
        )
        project, events = self.store.unresolved_unowned(
            root=root,
            event_ids=selected_ids,
            limit=int(request.get("limit", 200)),
        )
        files = [
            {
                "path": event["path"],
                "after_fingerprint": event["after_fingerprint"],
            }
            for event in events
        ]
        evidence = project_evidence(root, [item["path"] for item in files])
        if not evidence_matches_files(files, evidence):
            return {"status": "stale", "reason_code": "audit_evidence_stale"}
        bundle_core = {
            "project_hash": project["root_hash"],
            "event_ids": [event["id"] for event in events],
            "files": files,
            "evidence_hash": evidence["hash"],
            "skill_version": request["skill_version"],
        }
        bundle = {**bundle_core, "bundle_hash": sha256_json(bundle_core)}
        token, expires_at, status = self.store.mint_audit_token(
            project_id=int(project["id"]),
            bundle_hash=bundle["bundle_hash"],
            bundle=bundle,
            evidence_hash=evidence["hash"],
            skill_version=request["skill_version"],
        )
        return {
            "status": status,
            "reason_code": "audit_prepared",
            "audit_bundle": bundle,
            "audit_token": token,
            "expires_at": expires_at,
        }

    def _action_resolve_unowned(
        self,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        if request["decision_class"] in _USER_AUTHORIZATION_CLASSES:
            return {
                "status": "requires_user_authorization",
                "reason_code": "capability_fallback",
            }
        context = self.store.audit_context(request["audit_token"])
        if context is None:
            return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
        root = self._root(request["project"])
        if root != Path(context["root"]).resolve(strict=True):
            return {"status": "stale", "reason_code": "audit_evidence_stale"}
        bundle = context["bundle"]
        if request["event_ids"] != bundle["event_ids"]:
            return {"status": "stale", "reason_code": "audit_evidence_stale"}
        evidence = project_evidence(
            root,
            [item["path"] for item in bundle["files"]],
        )
        if evidence["hash"] != context["evidence_hash"]:
            return {"status": "stale", "reason_code": "audit_evidence_stale"}
        if not evidence_matches_files(bundle["files"], evidence):
            return {"status": "stale", "reason_code": "audit_evidence_stale"}
        receipt = request["audit_receipt"]
        unsigned_core = receipt_unsigned_core(receipt)
        trusted_attestation = self.store.receipt_attestation(
            purpose="audit",
            runtime_id=request["runtime_id"],
            session_key=request["session_id"],
            subject_id=request["audit_token"],
            unsigned_core=unsigned_core,
        )
        trusted_gate = run_local_gate(root)
        if not validate_audit_receipt(
            receipt,
            bundle_hash=bundle["bundle_hash"],
            event_ids=bundle["event_ids"],
            files=bundle["files"],
            evidence_hash=evidence["hash"],
            evidence_files=evidence["value"]["files"],
            audit_result=request["audit_result"],
            decision_class=request["decision_class"],
            trusted_gate=trusted_gate,
            trusted_attestation=trusted_attestation,
        ):
            return {"status": "invalid", "reason_code": "audit_receipt_invalid"}
        remediation = list(receipt["audit_output"]["remediation"])
        self.failure_injector("before_audit_final_validation")

        def final_validator() -> bool:
            final_evidence = project_evidence(
                root,
                [item["path"] for item in bundle["files"]],
            )
            return (
                final_evidence["hash"] == context["evidence_hash"]
                and evidence_matches_files(bundle["files"], final_evidence)
                and validate_audit_receipt(
                    receipt,
                    bundle_hash=bundle["bundle_hash"],
                    event_ids=bundle["event_ids"],
                    files=bundle["files"],
                    evidence_hash=final_evidence["hash"],
                    evidence_files=final_evidence["value"]["files"],
                    audit_result=request["audit_result"],
                    decision_class=request["decision_class"],
                    trusted_gate=run_local_gate(root),
                    trusted_attestation=trusted_attestation,
                )
            )

        return self.store.complete_audit(
            token=request["audit_token"],
            audit_result=request["audit_result"],
            decision_class=request["decision_class"],
            receipt_hash=receipt["receipt_hash"],
            gate_hash=receipt["gate"]["receipt_hash"],
            remediation=remediation,
            final_validator=final_validator,
        )
